#!/usr/bin/env python3
"""
Escrow Telegram Bot — однофайловая версия на aiogram 3 + SQLite + TON.

Установка и запуск (Linux):
    python3 -m venv venv
    source venv/bin/activate
    pip install --upgrade pip
    pip install aiogram==3.13.1 tonsdk==1.0.15 aiohttp==3.10.10
    python3 escrow_bot.py

База — файл escrow.db рядом со скриптом (создастся автоматически).
Логи — в stdout. Чтобы крутить 24/7 — оберни в systemd (см. конец файла).
"""

import asyncio
import json
import logging
import os
import sqlite3
import uuid
from typing import Optional

import aiohttp
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)
from tonsdk.contract.wallet import Wallets, WalletVersionEnum
from tonsdk.utils import Address, bytes_to_b64str

# ============================================================================
# КОНФИГ — секреты прямо здесь
# ============================================================================
BOT_TOKEN = "8790723889:AAHFo28YMSITgulGdvgnQRhDKEY7fkCa0W4"
ADMIN_CHAT_ID = -1003796999372
TON_WALLET_MNEMONIC = "mistake wild afraid law advice window shadow ladder true right teach clap quick wait pretty option raven web copper romance kidney skill ranch economy"
TONCENTER_API_KEY = "171f40d9c9bf3c146b0196b38cfaac5915b2201adbbc1b79a059d608d682650b"

DB_PATH = "escrow.db"
FEE_BPS = 300              # комиссия 3%
DEAL_LIMIT_PER_USER = 5
WATCHER_INTERVAL_S = 15
GAS_RESERVE_NANO = 50_000_000  # 0.05 TON держим как gas

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("escrow")

# ============================================================================
# БД
# ============================================================================
db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA foreign_keys=ON")
db_lock = asyncio.Lock()


def db_init() -> None:
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,
      username TEXT,
      lang TEXT DEFAULT 'ru',
      completed_count INTEGER DEFAULT 0,
      cancelled_count INTEGER DEFAULT 0,
      dispute_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS deals(
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      creator_id INTEGER NOT NULL,
      counterparty_id INTEGER NOT NULL,
      buyer_id INTEGER NOT NULL,
      seller_id INTEGER NOT NULL,
      amount_nano INTEGER NOT NULL,
      terms TEXT NOT NULL,
      status TEXT NOT NULL,
      previous_status TEXT,
      payment_tx_hash TEXT,
      payout_tx_hash TEXT,
      payout_address TEXT,
      payout_to_user_id INTEGER,
      dispute_opened_by INTEGER,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS i_deals_buyer ON deals(buyer_id);
    CREATE INDEX IF NOT EXISTS i_deals_seller ON deals(seller_id);
    CREATE INDEX IF NOT EXISTS i_deals_status ON deals(status);
    CREATE TABLE IF NOT EXISTS deal_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_id INTEGER,
      payload TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS processed_callbacks(
      callback_id TEXT PRIMARY KEY,
      processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS processed_transactions(
      tx_hash TEXT PRIMARY KEY,
      processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)


def _row(cur, r):
    return {c[0]: r[i] for i, c in enumerate(cur.description)} if r else None


def fetchone(sql, params=()) -> Optional[dict]:
    cur = db.execute(sql, params)
    return _row(cur, cur.fetchone())


def fetchall(sql, params=()) -> list[dict]:
    cur = db.execute(sql, params)
    return [_row(cur, r) for r in cur.fetchall()]


def execute(sql, params=()):
    return db.execute(sql, params)


# ============================================================================
# FSM СДЕЛКИ
# ============================================================================
ACTIVE = {
    "WAITING_CONFIRMATION", "WAITING_PAYMENT", "PAID", "SELLER_FULFILLED",
    "DISPUTE", "WAITING_PAYOUT_BUYER", "WAITING_PAYOUT_SELLER",
}
TRANSITIONS = {
    "WAITING_CONFIRMATION": {
        "ACCEPT": "WAITING_PAYMENT",
        "REJECT": "CANCELLED",
        "CANCEL": "CANCELLED",
    },
    "WAITING_PAYMENT": {"PAID": "PAID", "CANCEL": "CANCELLED"},
    "PAID": {
        "FULFILL": "SELLER_FULFILLED",
        "OPEN_DISPUTE": "DISPUTE",
        "CONCEDE_TO_SELLER": "WAITING_PAYOUT_SELLER",
        "CONCEDE_TO_BUYER": "WAITING_PAYOUT_BUYER",
    },
    "SELLER_FULFILLED": {
        "CONFIRM": "WAITING_PAYOUT_SELLER",
        "OPEN_DISPUTE": "DISPUTE",
        "CONCEDE_TO_SELLER": "WAITING_PAYOUT_SELLER",
        "CONCEDE_TO_BUYER": "WAITING_PAYOUT_BUYER",
    },
    "DISPUTE": {
        "RESOLVE_SELLER": "WAITING_PAYOUT_SELLER",
        "RESOLVE_BUYER": "WAITING_PAYOUT_BUYER",
    },
    "WAITING_PAYOUT_BUYER": {"PAYOUT_DONE": "REFUNDED"},
    "WAITING_PAYOUT_SELLER": {"PAYOUT_DONE": "COMPLETED"},
}


class CreateDeal(StatesGroup):
    role = State()
    counterparty = State()
    amount = State()
    terms = State()
    confirm = State()


class PayoutAddr(StatesGroup):
    enter = State()


# ============================================================================
# ТЕКСТЫ
# ============================================================================
M = {
    "menu": "🏦 *Escrow-бот*\n\nВыберите действие:",
    "btn_profile": "👤 Профиль",
    "btn_create": "➕ Создать сделку",
    "btn_active": "📋 Активные сделки",
    "btn_back": "⬅️ Назад",
    "profile": "👤 *Профиль*\n\n@{username}\nID: `{id}`\n\n✅ Успешных: *{ok}*\n❌ Отменённых: *{cancel}*\n⚖️ Споров: *{dispute}*",
    "create_role": "Кем вы выступаете в сделке?",
    "btn_buyer": "🛒 Покупатель",
    "btn_seller": "💰 Продавец",
    "create_cp": "Введите @username или ID второй стороны.\n_Она должна была хотя бы раз нажать /start у бота._",
    "create_amount": "Введите сумму сделки в TON (например 5 или 12.5):",
    "create_terms": "Опишите условия сделки одним сообщением:",
    "create_confirm": "*Подтвердите сделку*\n\nКод: `{code}`\nВы: *{role}*\nВторая сторона: @{cp}\nСумма: *{amount} TON*\nКомиссия (3%): *{fee} TON*\nК выплате продавцу: *{net} TON*\n\nУсловия:\n{terms}",
    "btn_confirm": "✅ Создать",
    "btn_cancel": "❌ Отмена",
    "create_done": "Сделка создана. Код: `{code}`. Ждём подтверждения второй стороны.",
    "limit": "У вас уже 5 активных сделок. Завершите или отмените одну.",
    "no_user": "Пользователь не найден. Он должен сначала нажать /start у бота.",
    "bad_amount": "Неверная сумма. Введите число, например 5 или 12.5.",
    "self_deal": "Нельзя создать сделку с самим собой.",
    "active_empty": "У вас нет активных сделок.",
    "active_list": "📋 *Активные сделки:*",
    "deal_view": "*Сделка `{code}`*\n\nСтатус: *{status}*\nВы: *{role}*\nВторая сторона: @{cp}\nСумма: *{amount} TON*\n\nУсловия:\n{terms}",
    "cp_invite": "📨 *Новая сделка `{code}`*\n\nОт: @{creator}\nВаша роль: *{role}*\nСумма: *{amount} TON*\n\nУсловия:\n{terms}\n\nПодтвердить?",
    "btn_accept": "✅ Принять",
    "btn_reject": "❌ Отклонить",
    "btn_pay": "💳 Оплатить",
    "btn_fulfill": "📦 Я выполнил",
    "btn_confirm_recv": "✅ Получено, оплатить продавца",
    "btn_dispute": "⚖️ Открыть спор",
    "btn_concede_s": "🤝 Отдать продавцу",
    "btn_concede_b": "🤝 Отдать покупателю",
    "btn_payout": "💸 Получить выплату",
    "pay_info": "💳 *Оплата сделки `{code}`*\n\nПереведите *{amount} TON* на адрес:\n`{addr}`\n\n*Обязательно* укажите комментарий:\n`{code}`\n\nБот проверяет платёж каждые 15 секунд.",
    "paid_buyer": "✅ Платёж по сделке `{code}` получен. Ждём, пока продавец выполнит обязательства.",
    "paid_seller": "✅ Покупатель оплатил сделку `{code}`. Выполните обязательства и нажмите «Я выполнил».",
    "fulfilled_buyer": "📦 Продавец отметил выполнение по сделке `{code}`. Если всё ок — нажмите «Получено», иначе откройте спор.",
    "confirm_recv_seller": "💸 Покупатель подтвердил получение по сделке `{code}`. Нажмите, чтобы получить выплату.",
    "dispute_opened": "⚖️ Спор по сделке `{code}` открыт. Ожидайте решения администратора.",
    "concede_to_seller": "🤝 Покупатель отдал средства по сделке `{code}`. Нажмите, чтобы получить выплату.",
    "concede_to_buyer": "🤝 Продавец вернул средства по сделке `{code}`. Нажмите, чтобы получить выплату.",
    "admin_resolved": "⚖️ Админ решил спор по сделке `{code}`. Нажмите, чтобы получить выплату.",
    "payout_prompt": "Введите ваш TON-адрес для получения выплаты по сделке `{code}`:",
    "payout_bad_addr": "Адрес не похож на корректный TON-адрес. Попробуйте ещё раз.",
    "payout_sent": "💸 Выплата по сделке `{code}` отправлена.\nTX hash: `{tx}`",
    "payout_fail": "Не удалось отправить выплату: {err}",
    "cancelled": "❌ Сделка `{code}` отменена.",
    "not_allowed": "Это действие сейчас недоступно.",
    "admin_paid": "💳 *Оплата получена*\n\nКод: `{code}`\nСумма: *{amount} TON*\nПродавец: @{seller}\nПокупатель: @{buyer}\n\nУсловия:\n{terms}",
    "admin_dispute": "⚖️ *СПОР по сделке `{code}`*\n\nСумма: *{amount} TON*\nПокупатель: @{buyer}\nПродавец: @{seller}\nОткрыл спор: @{by}\n\nУсловия:\n{terms}",
    "btn_adm_buyer": "💰 Вернуть покупателю",
    "btn_adm_seller": "💸 Отправить продавцу",
}


def t(k, **kw):
    s = M.get(k, k)
    return s.format(**kw) if kw else s


# ============================================================================
# УТИЛИТЫ
# ============================================================================
def nano_to_ton(n: int) -> str:
    s = f"{n / 1_000_000_000:.4f}"
    return s.rstrip("0").rstrip(".") or "0"


def ton_to_nano(s: str) -> int:
    return int(round(float(s) * 1_000_000_000))


def fee_nano(n: int) -> int:
    return n * FEE_BPS // 10000


def gen_code() -> str:
    return os.urandom(4).hex().upper()


def role_word(is_buyer: bool) -> str:
    return "Покупатель" if is_buyer else "Продавец"


def get_or_create_user(tg_id: int, username: Optional[str]) -> dict:
    u = fetchone("SELECT * FROM users WHERE id=?", (tg_id,))
    if not u:
        execute("INSERT INTO users(id, username) VALUES(?,?)", (tg_id, username))
        return fetchone("SELECT * FROM users WHERE id=?", (tg_id,))
    if username and u.get("username") != username:
        execute("UPDATE users SET username=? WHERE id=?", (username, tg_id))
        u["username"] = username
    return u


def find_user(query: str) -> Optional[dict]:
    q = query.strip().lstrip("@")
    if q.isdigit():
        return fetchone("SELECT * FROM users WHERE id=?", (int(q),))
    return fetchone("SELECT * FROM users WHERE LOWER(username)=LOWER(?)", (q,))


def uname(uid: int) -> str:
    u = fetchone("SELECT username FROM users WHERE id=?", (uid,))
    return (u.get("username") if u else None) or str(uid)


# ============================================================================
# TON
# ============================================================================
_mnem, _pub, _priv, wallet = Wallets.from_mnemonics(
    mnemonics=TON_WALLET_MNEMONIC.split(),
    version=WalletVersionEnum.v4r2,
    workchain=0,
)
WALLET_ADDR = wallet.address.to_string(True, True, False)  # non-bounceable EQ/UQ


async def toncenter_get(endpoint: str, params: dict) -> dict:
    p = dict(params)
    if TONCENTER_API_KEY:
        p["api_key"] = TONCENTER_API_KEY
    async with aiohttp.ClientSession() as s:
        async with s.get(f"https://toncenter.com/api/v2/{endpoint}", params=p, timeout=20) as r:
            return await r.json()


async def toncenter_post(endpoint: str, body: dict) -> dict:
    params = {"api_key": TONCENTER_API_KEY} if TONCENTER_API_KEY else None
    async with aiohttp.ClientSession() as s:
        async with s.post(f"https://toncenter.com/api/v2/{endpoint}", params=params, json=body, timeout=20) as r:
            return await r.json()


async def get_seqno() -> int:
    j = await toncenter_get("getWalletInformation", {"address": WALLET_ADDR})
    if j.get("ok") and j.get("result"):
        return j["result"].get("seqno") or 0
    return 0


async def send_ton(dest: str, amount_nano: int, comment: str = "") -> str:
    seqno = await get_seqno()
    transfer = wallet.create_transfer_message(
        to_addr=Address(dest),
        amount=amount_nano,
        seqno=seqno,
        payload=comment if comment else None,
    )
    boc_b64 = bytes_to_b64str(transfer["message"].to_boc(False))
    res = await toncenter_post("sendBoc", {"boc": boc_b64})
    if not res.get("ok"):
        raise RuntimeError(f"sendBoc failed: {res}")
    tx_hash = transfer["message"].bytes_hash().hex()
    # Ждём пока seqno изменится — значит транзакция включена
    for _ in range(30):
        await asyncio.sleep(3)
        if (await get_seqno()) > seqno:
            return tx_hash
    raise RuntimeError("timeout waiting for tx inclusion")


# ============================================================================
# ДЕЙСТВИЯ НАД СДЕЛКАМИ
# ============================================================================
async def transition(deal_id: str, action: str, actor_id: int, **patch) -> Optional[dict]:
    async with db_lock:
        d = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
        if not d:
            return None
        nxt = TRANSITIONS.get(d["status"], {}).get(action)
        if not nxt:
            log.info(f"deal {d['code']} {d['status']}: action {action} not allowed")
            return None
        execute(
            "UPDATE deals SET status=?, previous_status=?, version=version+1, "
            "updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?",
            (nxt, d["status"], deal_id, d["version"]),
        )
        for k, v in patch.items():
            execute(f"UPDATE deals SET {k}=? WHERE id=?", (v, deal_id))
        execute(
            "INSERT INTO deal_events(deal_id, event_type, actor_id, payload) VALUES(?,?,?,?)",
            (deal_id, action, actor_id, json.dumps(patch) if patch else None),
        )
        return fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))


def callback_seen(cb_id: str) -> bool:
    try:
        execute("INSERT INTO processed_callbacks(callback_id) VALUES(?)", (cb_id,))
        return False
    except sqlite3.IntegrityError:
        return True


# ============================================================================
# КЛАВИАТУРЫ
# ============================================================================
def main_menu_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=t("btn_profile"), callback_data="profile")],
        [InlineKeyboardButton(text=t("btn_create"), callback_data="create")],
        [InlineKeyboardButton(text=t("btn_active"), callback_data="active")],
    ])


def back_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=t("btn_back"), callback_data="back")]
    ])


def deal_kb(d: dict, uid: int) -> InlineKeyboardMarkup:
    st = d["status"]
    is_buyer = uid == d["buyer_id"]
    is_seller = uid == d["seller_id"]
    rows: list[list[InlineKeyboardButton]] = []
    if st == "WAITING_CONFIRMATION" and uid == d["counterparty_id"]:
        rows.append([
            InlineKeyboardButton(text=t("btn_accept"), callback_data=f"d:accept:{d['id']}"),
            InlineKeyboardButton(text=t("btn_reject"), callback_data=f"d:reject:{d['id']}"),
        ])
    if st == "WAITING_CONFIRMATION" and uid == d["creator_id"]:
        rows.append([InlineKeyboardButton(text=t("btn_cancel"), callback_data=f"d:cancel:{d['id']}")])
    if st == "WAITING_PAYMENT" and is_buyer:
        rows.append([InlineKeyboardButton(text=t("btn_pay"), callback_data=f"d:pay:{d['id']}")])
        rows.append([InlineKeyboardButton(text=t("btn_cancel"), callback_data=f"d:cancel:{d['id']}")])
    if st == "PAID" and is_seller:
        rows.append([InlineKeyboardButton(text=t("btn_fulfill"), callback_data=f"d:fulfill:{d['id']}")])
    if st == "PAID" and is_buyer:
        rows.append([InlineKeyboardButton(text=t("btn_dispute"), callback_data=f"d:dispute:{d['id']}")])
        rows.append([InlineKeyboardButton(text=t("btn_concede_s"), callback_data=f"d:concede_s:{d['id']}")])
    if st == "SELLER_FULFILLED" and is_buyer:
        rows.append([InlineKeyboardButton(text=t("btn_confirm_recv"), callback_data=f"d:confirm:{d['id']}")])
        rows.append([InlineKeyboardButton(text=t("btn_dispute"), callback_data=f"d:dispute:{d['id']}")])
    if st == "SELLER_FULFILLED" and is_seller:
        rows.append([InlineKeyboardButton(text=t("btn_concede_b"), callback_data=f"d:concede_b:{d['id']}")])
    if st == "WAITING_PAYOUT_BUYER" and is_buyer:
        rows.append([InlineKeyboardButton(text=t("btn_payout"), callback_data=f"d:payout:{d['id']}")])
    if st == "WAITING_PAYOUT_SELLER" and is_seller:
        rows.append([InlineKeyboardButton(text=t("btn_payout"), callback_data=f"d:payout:{d['id']}")])
    rows.append([InlineKeyboardButton(text=t("btn_back"), callback_data="back")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def admin_dispute_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=t("btn_adm_buyer"), callback_data=f"adm:buyer:{deal_id}")],
        [InlineKeyboardButton(text=t("btn_adm_seller"), callback_data=f"adm:seller:{deal_id}")],
    ])


# ============================================================================
# БОТ
# ============================================================================
bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.MARKDOWN))
dp = Dispatcher(storage=MemoryStorage())
router = Router()
dp.include_router(router)


async def safe_edit(msg: Message, text: str, kb: Optional[InlineKeyboardMarkup] = None):
    try:
        await msg.edit_text(text, reply_markup=kb)
    except TelegramBadRequest:
        await msg.answer(text, reply_markup=kb)


async def safe_send(chat_id: int, text: str, kb: Optional[InlineKeyboardMarkup] = None):
    try:
        await bot.send_message(chat_id, text, reply_markup=kb)
    except Exception as e:
        log.warning(f"send to {chat_id} failed: {e}")


def deal_view_text(d: dict, viewer: int) -> str:
    if viewer == d["buyer_id"]:
        role, cp_id = "Покупатель", d["seller_id"]
    elif viewer == d["seller_id"]:
        role, cp_id = "Продавец", d["buyer_id"]
    else:
        role, cp_id = "—", d["counterparty_id"]
    return t("deal_view", code=d["code"], status=d["status"], role=role,
             cp=uname(cp_id), amount=nano_to_ton(d["amount_nano"]), terms=d["terms"])


# ----- /start
@router.message(CommandStart())
async def cmd_start(m: Message, state: FSMContext):
    await state.clear()
    get_or_create_user(m.from_user.id, m.from_user.username)
    await m.answer(t("menu"), reply_markup=main_menu_kb())


# ----- Профиль
@router.callback_query(F.data == "profile")
async def cb_profile(c: CallbackQuery):
    if callback_seen(c.id):
        return
    u = get_or_create_user(c.from_user.id, c.from_user.username)
    await safe_edit(c.message, t("profile",
        username=u.get("username") or "—",
        id=u["id"],
        ok=u["completed_count"],
        cancel=u["cancelled_count"],
        dispute=u["dispute_count"],
    ), back_kb())
    await c.answer()


# ----- Назад
@router.callback_query(F.data == "back")
async def cb_back(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    await state.clear()
    await safe_edit(c.message, t("menu"), main_menu_kb())
    await c.answer()


# ----- Создание сделки: wizard
@router.callback_query(F.data == "create")
async def cb_create(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    get_or_create_user(c.from_user.id, c.from_user.username)
    cnt = fetchone(
        "SELECT COUNT(*) c FROM deals WHERE (buyer_id=? OR seller_id=?) AND status IN "
        "('WAITING_CONFIRMATION','WAITING_PAYMENT','PAID','SELLER_FULFILLED','DISPUTE',"
        " 'WAITING_PAYOUT_BUYER','WAITING_PAYOUT_SELLER')",
        (c.from_user.id, c.from_user.id),
    )
    if cnt and cnt["c"] >= DEAL_LIMIT_PER_USER:
        await c.answer(t("limit"), show_alert=True)
        return
    await state.set_state(CreateDeal.role)
    await safe_edit(c.message, t("create_role"), InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=t("btn_buyer"), callback_data="role:buyer")],
        [InlineKeyboardButton(text=t("btn_seller"), callback_data="role:seller")],
        [InlineKeyboardButton(text=t("btn_back"), callback_data="back")],
    ]))
    await c.answer()


@router.callback_query(F.data.startswith("role:"), CreateDeal.role)
async def cb_role(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    await state.update_data(role=c.data.split(":", 1)[1])
    await state.set_state(CreateDeal.counterparty)
    await safe_edit(c.message, t("create_cp"))
    await c.answer()


@router.message(CreateDeal.counterparty)
async def m_cp(m: Message, state: FSMContext):
    other = find_user(m.text or "")
    if not other:
        await m.answer(t("no_user"))
        return
    if other["id"] == m.from_user.id:
        await m.answer(t("self_deal"))
        return
    await state.update_data(other_id=other["id"], other_username=other.get("username") or "")
    await state.set_state(CreateDeal.amount)
    await m.answer(t("create_amount"))


@router.message(CreateDeal.amount)
async def m_amount(m: Message, state: FSMContext):
    try:
        amt = float((m.text or "").strip().replace(",", "."))
        if amt <= 0:
            raise ValueError
    except Exception:
        await m.answer(t("bad_amount"))
        return
    await state.update_data(amount_nano=ton_to_nano(amt))
    await state.set_state(CreateDeal.terms)
    await m.answer(t("create_terms"))


@router.message(CreateDeal.terms)
async def m_terms(m: Message, state: FSMContext):
    txt = (m.text or "").strip()[:1000]
    if not txt:
        await m.answer("Условия не могут быть пустыми.")
        return
    data = await state.get_data()
    amt = data["amount_nano"]
    fee = fee_nano(amt)
    code = gen_code()
    await state.update_data(terms=txt, code=code)
    await state.set_state(CreateDeal.confirm)
    await m.answer(t("create_confirm",
        code=code,
        role=role_word(data["role"] == "buyer"),
        cp=data.get("other_username") or str(data["other_id"]),
        amount=nano_to_ton(amt), fee=nano_to_ton(fee), net=nano_to_ton(amt - fee),
        terms=txt,
    ), reply_markup=InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=t("btn_confirm"), callback_data="create_go")],
        [InlineKeyboardButton(text=t("btn_cancel"), callback_data="back")],
    ]))


@router.callback_query(F.data == "create_go", CreateDeal.confirm)
async def cb_create_go(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    data = await state.get_data()
    if data["role"] == "buyer":
        buyer, seller = c.from_user.id, data["other_id"]
    else:
        buyer, seller = data["other_id"], c.from_user.id
    did = str(uuid.uuid4())
    execute(
        "INSERT INTO deals(id, code, creator_id, counterparty_id, buyer_id, seller_id, "
        "amount_nano, terms, status) VALUES(?,?,?,?,?,?,?,?, 'WAITING_CONFIRMATION')",
        (did, data["code"], c.from_user.id, data["other_id"], buyer, seller,
         data["amount_nano"], data["terms"]),
    )
    execute("INSERT INTO deal_events(deal_id, event_type, actor_id) VALUES(?,?,?)",
            (did, "CREATED", c.from_user.id))
    deal = fetchone("SELECT * FROM deals WHERE id=?", (did,))
    cp_role = role_word(data["role"] == "seller")  # роль второй стороны — обратная
    await safe_send(
        data["other_id"],
        t("cp_invite",
            code=deal["code"],
            creator=uname(c.from_user.id),
            role=cp_role,
            amount=nano_to_ton(deal["amount_nano"]),
            terms=deal["terms"]),
        deal_kb(deal, data["other_id"]),
    )
    await state.clear()
    await safe_edit(c.message, t("create_done", code=deal["code"]), main_menu_kb())
    await c.answer()


# ----- Активные сделки
@router.callback_query(F.data == "active")
async def cb_active(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deals = fetchall(
        "SELECT * FROM deals WHERE (buyer_id=? OR seller_id=?) AND status IN "
        "('WAITING_CONFIRMATION','WAITING_PAYMENT','PAID','SELLER_FULFILLED','DISPUTE',"
        " 'WAITING_PAYOUT_BUYER','WAITING_PAYOUT_SELLER') ORDER BY created_at DESC LIMIT 10",
        (c.from_user.id, c.from_user.id),
    )
    if not deals:
        await safe_edit(c.message, t("active_empty"), back_kb())
        await c.answer()
        return
    rows = [[InlineKeyboardButton(
        text=f"{d['code']} · {nano_to_ton(d['amount_nano'])} TON · {d['status']}",
        callback_data=f"d:view:{d['id']}",
    )] for d in deals]
    rows.append([InlineKeyboardButton(text=t("btn_back"), callback_data="back")])
    await safe_edit(c.message, t("active_list"), InlineKeyboardMarkup(inline_keyboard=rows))
    await c.answer()


# ----- Действия по сделке
@router.callback_query(F.data.startswith("d:"))
async def cb_deal(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    try:
        _, action, deal_id = c.data.split(":", 2)
    except ValueError:
        await c.answer()
        return
    deal = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not deal:
        await c.answer("Сделка не найдена", show_alert=True)
        return
    me = c.from_user.id

    if action == "view":
        await safe_edit(c.message, deal_view_text(deal, me), deal_kb(deal, me))
        await c.answer()
        return

    if action == "accept":
        d2 = await transition(deal_id, "ACCEPT", me)
        if not d2:
            await c.answer(t("not_allowed"), show_alert=True)
            return
        await safe_send(
            deal["buyer_id"],
            t("pay_info", code=deal["code"], amount=nano_to_ton(deal["amount_nano"]), addr=WALLET_ADDR),
            deal_kb(d2, deal["buyer_id"]),
        )
        await safe_send(
            deal["seller_id"],
            f"⏳ Покупатель оплачивает сделку `{deal['code']}`. Ожидание платежа.",
            deal_kb(d2, deal["seller_id"]),
        )
        await safe_edit(c.message, f"✅ Сделка `{deal['code']}` принята.", main_menu_kb())
        await c.answer()
        return

    if action in ("reject", "cancel"):
        d2 = await transition(deal_id, "CANCEL" if action == "cancel" else "REJECT", me)
        if not d2:
            await c.answer(t("not_allowed"), show_alert=True)
            return
        execute("UPDATE users SET cancelled_count=cancelled_count+1 WHERE id IN (?,?)",
                (deal["buyer_id"], deal["seller_id"]))
        for uid in (deal["buyer_id"], deal["seller_id"]):
            if uid != me:
                await safe_send(uid, t("cancelled", code=deal["code"]))
        await safe_edit(c.message, t("cancelled", code=deal["code"]), main_menu_kb())
        await c.answer()
        return

    if action == "pay":
        await safe_edit(
            c.message,
            t("pay_info", code=deal["code"], amount=nano_to_ton(deal["amount_nano"]), addr=WALLET_ADDR),
            deal_kb(deal, me),
        )
        await c.answer()
        return

    if action == "fulfill":
        d2 = await transition(deal_id, "FULFILL", me)
        if not d2:
            await c.answer(t("not_allowed"), show_alert=True)
            return
        await safe_send(deal["buyer_id"], t("fulfilled_buyer", code=deal["code"]),
                        deal_kb(d2, deal["buyer_id"]))
        await safe_edit(c.message, "📦 Отмечено как выполнено. Ждём подтверждения покупателя.",
                        main_menu_kb())
        await c.answer()
        return

    if action == "confirm":
        d2 = await transition(deal_id, "CONFIRM", me, payout_to_user_id=deal["seller_id"])
        if not d2:
            await c.answer(t("not_allowed"), show_alert=True)
            return
        await safe_send(deal["seller_id"], t("confirm_recv_seller", code=deal["code"]),
                        deal_kb(d2, deal["seller_id"]))
        await safe_edit(c.message, "✅ Принято. Продавцу выслана кнопка получения выплаты.",
                        main_menu_kb())
        await c.answer()
        return

    if action == "dispute":
        d2 = await transition(deal_id, "OPEN_DISPUTE", me, dispute_opened_by=me)
        if not d2:
            await c.answer(t("not_allowed"), show_alert=True)
            return
        execute("UPDATE users SET dispute_count=dispute_count+1 WHERE id IN (?,?)",
                (deal["buyer_id"], deal["seller_id"]))
        for uid in (deal["buyer_id"], deal["seller_id"]):
            if uid != me:
                await safe_send(uid, t("dispute_opened", code=deal["code"]))
        await safe_send(ADMIN_CHAT_ID, t("admin_dispute",
            code=deal["code"],
            amount=nano_to_ton(deal["amount_nano"]),
            buyer=uname(deal["buyer_id"]),
            seller=uname(deal["seller_id"]),
            by=uname(me),
            terms=deal["terms"],
        ), admin_dispute_kb(deal_id))
        await safe_edit(c.message, t("dispute_opened", code=deal["code"]), main_menu_kb())
        await c.answer()
        return

    if action == "concede_s":
        d2 = await transition(deal_id, "CONCEDE_TO_SELLER", me, payout_to_user_id=deal["seller_id"])
        if not d2:
            await c.answer(t("not_allowed"), show_alert=True)
            return
        await safe_send(deal["seller_id"], t("concede_to_seller", code=deal["code"]),
                        deal_kb(d2, deal["seller_id"]))
        await safe_edit(c.message, "🤝 Средства переданы продавцу.", main_menu_kb())
        await c.answer()
        return

    if action == "concede_b":
        d2 = await transition(deal_id, "CONCEDE_TO_BUYER", me, payout_to_user_id=deal["buyer_id"])
        if not d2:
            await c.answer(t("not_allowed"), show_alert=True)
            return
        await safe_send(deal["buyer_id"], t("concede_to_buyer", code=deal["code"]),
                        deal_kb(d2, deal["buyer_id"]))
        await safe_edit(c.message, "🤝 Средства возвращены покупателю.", main_menu_kb())
        await c.answer()
        return

    if action == "payout":
        if deal.get("payout_to_user_id") != me:
            await c.answer(t("not_allowed"), show_alert=True)
            return
        await state.set_state(PayoutAddr.enter)
        await state.update_data(deal_id=deal_id)
        await safe_edit(c.message, t("payout_prompt", code=deal["code"]))
        await c.answer()
        return


# ----- Ввод адреса выплаты
@router.message(PayoutAddr.enter)
async def m_payout(m: Message, state: FSMContext):
    data = await state.get_data()
    addr = (m.text or "").strip()
    try:
        Address(addr)  # валидация
    except Exception:
        await m.answer(t("payout_bad_addr"))
        return
    deal = fetchone("SELECT * FROM deals WHERE id=?", (data.get("deal_id"),))
    if not deal or deal.get("payout_to_user_id") != m.from_user.id:
        await m.answer(t("not_allowed"))
        await state.clear()
        return
    # Сумма выплаты
    if deal["status"] == "WAITING_PAYOUT_SELLER":
        amount = deal["amount_nano"] - fee_nano(deal["amount_nano"]) - GAS_RESERVE_NANO
    elif deal["status"] == "WAITING_PAYOUT_BUYER":
        amount = deal["amount_nano"] - GAS_RESERVE_NANO
    else:
        await m.answer(t("not_allowed"))
        await state.clear()
        return
    if amount <= 0:
        await m.answer("Сумма слишком мала для выплаты после комиссии сети.")
        await state.clear()
        return
    await m.answer("⏳ Отправляю выплату...")
    try:
        tx = await send_ton(addr, amount, comment=f"escrow {deal['code']}")
    except Exception as e:
        log.exception("payout failed")
        await m.answer(t("payout_fail", err=str(e)[:200]))
        await state.clear()
        return
    d2 = await transition(deal["id"], "PAYOUT_DONE", m.from_user.id,
                          payout_tx_hash=tx, payout_address=addr)
    if d2 and d2["status"] == "COMPLETED":
        execute("UPDATE users SET completed_count=completed_count+1 WHERE id IN (?,?)",
                (deal["buyer_id"], deal["seller_id"]))
    await state.clear()
    await m.answer(t("payout_sent", code=deal["code"], tx=tx), reply_markup=main_menu_kb())


# ----- Админ: решение спора
@router.callback_query(F.data.startswith("adm:"))
async def cb_admin(c: CallbackQuery):
    if callback_seen(c.id):
        return
    if c.from_user.id != ADMIN_CHAT_ID and c.message.chat.id != ADMIN_CHAT_ID:
        await c.answer("Нет доступа", show_alert=True)
        return
    _, side, deal_id = c.data.split(":", 2)
    deal = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not deal or deal["status"] != "DISPUTE":
        await c.answer("Спор уже решён или не найден", show_alert=True)
        return
    if side == "buyer":
        d2 = await transition(deal_id, "RESOLVE_BUYER", c.from_user.id,
                              payout_to_user_id=deal["buyer_id"])
        target = deal["buyer_id"]
    else:
        d2 = await transition(deal_id, "RESOLVE_SELLER", c.from_user.id,
                              payout_to_user_id=deal["seller_id"])
        target = deal["seller_id"]
    if d2:
        await safe_send(target, t("admin_resolved", code=deal["code"]), deal_kb(d2, target))
        try:
            await c.message.edit_reply_markup(reply_markup=None)
        except TelegramBadRequest:
            pass
    await c.answer("Решение применено")


# ============================================================================
# WATCHER ВХОДЯЩИХ ПЛАТЕЖЕЙ
# ============================================================================
async def payment_watcher():
    log.info("payment watcher started")
    while True:
        try:
            j = await toncenter_get("getTransactions",
                                    {"address": WALLET_ADDR, "limit": 20, "archival": "false"})
            txs = j.get("result", []) if j.get("ok") else []
            for tx in txs:
                in_msg = tx.get("in_msg") or {}
                if not in_msg.get("source"):
                    continue
                tx_id = tx.get("transaction_id") or {}
                tx_hash = tx_id.get("hash")
                if not tx_hash:
                    continue
                value = int(in_msg.get("value") or 0)
                comment = (in_msg.get("message") or "").strip()
                if not comment:
                    continue
                try:
                    execute("INSERT INTO processed_transactions(tx_hash) VALUES(?)", (tx_hash,))
                except sqlite3.IntegrityError:
                    continue
                deal = fetchone(
                    "SELECT * FROM deals WHERE code=? AND status='WAITING_PAYMENT'",
                    (comment,),
                )
                if not deal:
                    log.info(f"tx {tx_hash[:10]} comment={comment} no matching deal")
                    continue
                if value < deal["amount_nano"]:
                    log.warning(f"tx {tx_hash[:10]} amount {value} < expected {deal['amount_nano']}")
                    continue
                d2 = await transition(deal["id"], "PAID", 0, payment_tx_hash=tx_hash)
                if d2:
                    log.info(f"deal {deal['code']} -> PAID via {tx_hash[:10]}")
                    await safe_send(deal["buyer_id"], t("paid_buyer", code=deal["code"]),
                                    deal_kb(d2, deal["buyer_id"]))
                    await safe_send(deal["seller_id"], t("paid_seller", code=deal["code"]),
                                    deal_kb(d2, deal["seller_id"]))
                    await safe_send(ADMIN_CHAT_ID, t("admin_paid",
                        code=deal["code"],
                        amount=nano_to_ton(deal["amount_nano"]),
                        seller=uname(deal["seller_id"]),
                        buyer=uname(deal["buyer_id"]),
                        terms=deal["terms"],
                    ))
        except Exception as e:
            log.warning(f"watcher error: {e}")
        await asyncio.sleep(WATCHER_INTERVAL_S)


# ============================================================================
# MAIN
# ============================================================================
async def main():
    db_init()
    log.info(f"TON wallet address: {WALLET_ADDR}")
    asyncio.create_task(payment_watcher())
    me = await bot.get_me()
    log.info(f"Bot started: @{me.username}")
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())


if __name__ == "__main__":
    asyncio.run(main())


# ============================================================================
# systemd unit (опционально). Создай /etc/systemd/system/escrow-bot.service:
#
# [Unit]
# Description=Escrow Telegram Bot
# After=network.target
#
# [Service]
# Type=simple
# User=root
# WorkingDirectory=/root/escrow
# ExecStart=/root/escrow/venv/bin/python3 /root/escrow/escrow_bot.py
# Restart=always
# RestartSec=10
# StandardOutput=journal
# StandardError=journal
#
# [Install]
# WantedBy=multi-user.target
#
# Затем:
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now escrow-bot
#   sudo journalctl -u escrow-bot -f
# ============================================================================
