#!/usr/bin/env bash
# Grow the root partition + filesystem to use the whole disk (after a VPS upgrade).
#   sudo bash expand-disk.sh
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
SRC="$(findmnt -n -o SOURCE /)"; FST="$(findmnt -n -o FSTYPE /)"
echo "Корень: $SRC ($FST)"; df -h / | tail -1

ensure_growpart() {
  command -v growpart >/dev/null && return 0
  apt-get install -y -q cloud-guest-utils >/dev/null 2>&1 && command -v growpart >/dev/null && return 0
  curl -fsSL https://raw.githubusercontent.com/canonical/cloud-utils/main/bin/growpart -o /usr/local/bin/growpart && chmod +x /usr/local/bin/growpart
}
grow_fs() { # $1 device
  case "$FST" in
    ext2|ext3|ext4) resize2fs "$1" ;;
    xfs) xfs_growfs / ;;
    btrfs) btrfs filesystem resize max / ;;
    *) echo "Неизвестная ФС $FST"; return 1 ;;
  esac
}

if [[ "$SRC" == /dev/mapper/* ]] || lvs "$SRC" >/dev/null 2>&1; then
  # LVM: grow the physical volume's partition, then the logical volume
  PV="$(pvs --noheadings -o pv_name 2>/dev/null | head -1 | tr -d ' ')"
  DISK="/dev/$(lsblk -no pkname "$PV")"; NUM="$(cat /sys/class/block/$(basename "$PV")/partition)"
  ensure_growpart && growpart "$DISK" "$NUM" || true
  pvresize "$PV"
  lvextend -r -l +100%FREE "$SRC" || true
else
  PK="$(lsblk -no pkname "$SRC")"
  if [ -z "$PK" ]; then echo "Корень — целый диск без разделов"; grow_fs "$SRC"; else
    DISK="/dev/$PK"; NUM="$(cat /sys/class/block/$(basename "$SRC")/partition)"
    echo "Диск $DISK, раздел $NUM"
    ensure_growpart || { echo "Нет growpart"; exit 1; }
    growpart "$DISK" "$NUM" || echo "(раздел уже максимального размера или growpart не нужен)"
    grow_fs "$SRC"
  fi
fi
echo "--- после:"; df -h / | tail -1
