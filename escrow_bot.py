#!/usr/bin/env python3
"""
Escrow Telegram Bot — однофайловая версия на aiogram 3 + SQLite + TON.
Тексты, баннер и формат карточек — 1:1 с TS-версией.

Установка и запуск (Linux):
    python3 -m venv venv
    source venv/bin/activate
    pip install --upgrade pip
    pip install aiogram==3.13.1 tonsdk==1.0.15 aiohttp==3.10.10
    python3 escrow_bot.py
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
from aiogram.filters import CommandStart, Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    CallbackQuery,
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaPhoto,
    Message,
)
from tonsdk.contract.wallet import Wallets, WalletVersionEnum
from tonsdk.utils import Address, bytes_to_b64str

# ============================================================================
# КОНФИГ
# ============================================================================
BOT_TOKEN = '8968269532:AAHtQ7hE9RtcHaZKdByViy0P7_wwRiXpUQ4'
ADMIN_CHAT_ID = -1003796999372
TON_WALLET_MNEMONIC = 'mistake wild afraid law advice window shadow ladder true right teach clap quick wait pretty option raven web copper romance kidney skill ranch economy'
TONCENTER_API_KEY = '171f40d9c9bf3c146b0196b38cfaac5915b2201adbbc1b79a059d608d682650b'

FEE_WALLET = "UQCPn5jqyd8AvIX8D1Oh-b0AIj40jdgezsmaFcPvZrR9phy7"
DB_PATH = "escrow.db"
BANNER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "banner.jpg")

FEE_BPS = 300                 # 3%
DEAL_LIMIT_PER_USER = 5
WATCHER_INTERVAL_S = 15
GAS_RESERVE_NANO = 50_000_000  # 0.05 TON
CAPTION_MAX = 1024

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
db_lock = asyncio.Lock()


def db_init() -> None:
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,
      username TEXT,
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
      amount_nano INTEGER NOT NULL,         -- NET (продавец получает столько)
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
# ТЕКСТЫ (1:1 с TS i18n.ts, RU)
# ============================================================================
def t_profile_stats(username, completed, cancelled, disputes):
    return (f"ℹ️ *Личный кабинет @{username or '—'}.*\n\n"
            f"Отмен: {cancelled}\nСпоров: {disputes}\nСделок: {completed}")


def t_active_limit_reached(limit):
    return (f"Достигнут лимит активных сделок ({limit}). "
            f"Завершите текущие, чтобы создать новую.")


def t_create_summary(role, amount, to_pay, terms):
    return (f"ℹ️ *Тщательно проверьте условия сделки:*\n\n"
            f"*Ваша роль:* {role}\n"
            f"*Сумма сделки:* {amount} TON\n"
            f"*Сумма с комиссией:* {to_pay} TON\n\n"
            f"*Условия сделки:*\n{terms}")


def t_create_sent(opp_role):
    return f"ℹ️ *Ожидаете подтверждения сделки {opp_role}.*"


def t_notif_new_deal(role, amount, to_pay, terms):
    return (f"ℹ️ *У вас новое предложение о сделке:*\n\n"
            f"*Ваша роль:* {role}\n"
            f"*Сумма сделки:* {amount} TON\n"
            f"*Сумма с комиссией:* {to_pay} TON\n\n"
            f"*Условия сделки:*\n{terms}")


def t_deal_card(intro, role, amount, to_pay, terms):
    return (f"{intro}\n\n"
            f"*Ваша роль:* {role}\n"
            f"*Сумма сделки:* {amount} TON\n"
            f"*Сумма с комиссией:* {to_pay} TON\n\n"
            f"*Условия сделки:*\n{terms}")


def t_pay_instructions(address, amount, code):
    return (f"ℹ️ *Оплатите сделку строго по реквизитам ниже:*\n\n"
            f"Адрес TON: `{address}`\n"
            f"Точная сумма: {amount} TON\n"
            f"Комментарий: `{code}`")


def t_payout_processing(address, amount):
    return (f"⏳ Отправляю {amount} TON на адрес:\n`{address}`\n\n"
            f"Это займёт до 30 секунд...")


def t_payout_sent(amount, address, explorer):
    return (f"✅ Средства отправлены\n\n"
            f"💰 Сумма: *{amount} TON*\n"
            f"📍 На адрес: `{address}`\n\n"
            f"🔎 [Посмотреть транзакцию]({explorer})")


def t_admin_log_paid(code, amount, seller, buyer, terms):
    return (f"💰 Оплачена сделка #{code}\n\n"
            f"Сумма: {amount} TON\n"
            f"Продавец: {seller}\n"
            f"Покупатель: {buyer}\n\n"
            f"Условия:\n{terms}")


def t_admin_dispute_panel(code, buyer, seller, amount, terms):
    return (f"⚖️ Спор #{code}\n"
            f"Покупатель: {buyer}\n"
            f"Продавец: {seller}\n"
            f"Сумма: {amount} TON\n\n"
            f"Условия:\n{terms}")


MAIN_MENU = "\u00A0"

PROFILE_TITLE = "👤 Профиль"
ACTIVE_DEALS_TITLE = "ℹ️ *Твои активные сделки:*"
NO_ACTIVE_DEALS = "ℹ️ *У тебя нет активных сделок.*"

CREATE_CHOOSE_ROLE = "ℹ️ *Ваша роль в сделке?*"
CREATE_ASK_COUNTERPARTY = "ℹ️ *Укажите Username или Telegram ID второй стороны сделки:*"
COUNTERPARTY_NOT_FOUND = ("ℹ️ *Не удалось найти пользователя.*\n\n"
                         "Ответчик должен запустить бота. Зарегистрируйтесь и попробуйте ещё раз.")
COUNTERPARTY_IS_SELF = "Нельзя создать сделку с самим собой."
CREATE_ASK_AMOUNT = ("ℹ️ *Укажите сумму сделки в TON.*\n\n"
                    "Комиссия 3% будет добавлена к сумме сделки.")
INVALID_AMOUNT = ("ℹ️ *Сумма указана некорректно.*\n\n"
                 "Укажите сумму на подобии примеров: 10 | 15.2 | 0.9.")
CREATE_ASK_TERMS = ("ℹ️ *Подробно распишите условия сделки.*\n\n"
                   "Укажите что передает продавец, в какие сроки он должен уложиться, "
                   "укажите качества, детали, ID / Номер / # продукта.")
TERMS_TOO_LONG = "Слишком длинное описание. Максимум 2000 символов."
CREATE_CANCELLED = "Создание сделки отменено."

CONFIRM_REJECT_DEAL = "Вы уверены, что хотите отклонить сделку?"
DEAL_REJECTED_BY_CP = "Вторая сторона отклонила сделку. Сделка отменена."
DEAL_ACCEPTED = "ℹ️ *Сделка принята второй стороной.*"

CANCEL_CONFIRM = "Вы уверены, что хотите отменить сделку?"
DEAL_CANCELLED = "Сделка отменена."
DEAL_CANCELLED_SELLER_AFTER_PAY = "Продавец отменил сделку после оплаты. Заберите свои средства."

SELLER_FULFILLED_BUYER = "Продавец сообщил, что выполнил условия. Подтвердите выполнение, если всё ок."
BUYER_CONFIRM_PROMPT = "Вы уверены, что условия выполнены? Это завершит сделку."
DEAL_COMPLETED = "🎉 Сделка успешно завершена."

DISPUTE_OPENED = "⚖️ Спор открыт. Ожидайте решения администратора."
DISPUTE_CANCELLED = "Спор отменён. Сделка возвращена к предыдущему этапу."

PAYOUT_ASK_ADDRESS = "Введите ваш TON-адрес для получения средств:"
PAYOUT_READY_SELLER = ("🎉 Сделка завершена! Покупатель подтвердил получение. "
                     "Нажмите кнопку «Получить средства», чтобы указать TON-адрес для выплаты.")
PAYOUT_READY_BUYER = ("🎉 Спор решён в вашу пользу. Нажмите «Получить средства», "
                    "чтобы указать TON-адрес для возврата.")
PAYOUT_INVALID_ADDRESS = "Некорректный TON-адрес. Попробуйте ещё раз."
PAYOUT_FAILED = "Не удалось отправить средства. Свяжитесь с администратором."

INVALID_ACTION = "Это действие сейчас недоступно."
ERROR_GENERIC = "Произошла ошибка. Попробуйте ещё раз."

# Кнопки
BTN_PROFILE = "👤 Профиль"
BTN_CREATE_DEAL = "➕ Создать сделку"
BTN_ACTIVE_DEALS = "📂 Активные сделки"
BTN_MAIN_MENU = "🏠 Главное меню"
BTN_BACK = "⬅️ Вернуться назад"
BTN_CONFIRM = "✅ Подтвердить"
BTN_CANCEL = "❌ Отменить"
BTN_YES = "Да"
BTN_NO = "Нет"
BTN_ROLE_BUYER = "🛒 Покупатель"
BTN_ROLE_SELLER = "💼 Продавец"
BTN_PAY = "💸 Оплатить сделку"
BTN_CHECK_PAYMENT = "🔄 Проверить оплату"
BTN_CANCEL_DEAL = "❌ Отменить сделку"
BTN_OPEN_DISPUTE = "⚖️ Открыть спор"
BTN_OPEN_DEAL = "📂 Открыть сделку"
BTN_SELLER_FULFILLED = "✔️ Я выполнил условия"
BTN_BUYER_CONFIRM = "✅ Подтвердить выполнение"
BTN_GET_FUNDS = "💰 Получить средства"
BTN_ACCEPT_DEAL = "Принять"
BTN_REJECT_DEAL = "Отклонить"
BTN_GIVE_TO_BUYER = "Отдать деньги покупателю"
BTN_GIVE_TO_SELLER = "Отдать деньги продавцу"
BTN_CONCEDE = "🙏 Уступить оппоненту"
BTN_ADMIN_TO_BUYER = "Победил покупатель"
BTN_ADMIN_TO_SELLER = "Победил продавец"
BTN_ADMIN_CANCEL_DISPUTE = "Отменить спор"

ROLE_BUYER = "Покупатель"
ROLE_SELLER = "Продавец"
ROLE_BY_BUYER = "покупателем"
ROLE_BY_SELLER = "продавцом"

CARD_INTRO = {
    ("WAITING_PAYMENT", "buyer"):       "ℹ️ *Оплатите сделку с помощью кнопки ниже.*",
    ("WAITING_PAYMENT", "seller"):      "ℹ️ *Ожидайте оплаты сделки покупателем.*",
    ("PAID", "buyer"):                  "ℹ️ *Ожидайте выполнения условий сделки продавцом.*",
    ("PAID", "seller"):                 "ℹ️ *Покупатель оплатил сделку. Приступайте к выполнению условий.*",
    ("SELLER_FULFILLED", "buyer"):      "ℹ️ *Продавец сообщил, что выполнил условия сделки. Тщательно проверьте выполнение.*",
    ("SELLER_FULFILLED", "seller"):     "ℹ️ *Ожидайте проверки выполнения условий покупателем.*",
    ("DISPUTE", "buyer"):               "ℹ️ *Открыт спор. Ожидайте решения администратора.*",
    ("DISPUTE", "seller"):              "ℹ️ *Открыт спор. Ожидайте решения администратора.*",
    ("WAITING_PAYOUT_BUYER", "buyer"):  "ℹ️ *Заберите свои средства — нажмите «Получить средства».*",
    ("WAITING_PAYOUT_BUYER", "seller"): "ℹ️ *Возврат средств покупателю.*",
    ("WAITING_PAYOUT_SELLER", "buyer"): "ℹ️ *Выплата продавцу.*",
    ("WAITING_PAYOUT_SELLER", "seller"):"ℹ️ *Сделка завершена. Заберите свои средства.*",
    ("COMPLETED", "buyer"):             "ℹ️ *Сделка успешно завершена.*",
    ("COMPLETED", "seller"):            "ℹ️ *Сделка успешно завершена.*",
    ("CANCELLED", "buyer"):             "ℹ️ *Сделка отменена.*",
    ("CANCELLED", "seller"):            "ℹ️ *Сделка отменена.*",
    ("REFUNDED", "buyer"):              "ℹ️ *Средства возвращены.*",
    ("REFUNDED", "seller"):             "ℹ️ *Средства возвращены.*",
}


# ============================================================================
# УТИЛИТЫ
# ============================================================================
def nano_to_ton(n: int) -> str:
    s = f"{n / 1_000_000_000:.9f}"
    return s.rstrip("0").rstrip(".") or "0"


def ton_to_nano(s: str) -> int:
    return int(round(float(s) * 1_000_000_000))


def fee_nano(net: int) -> int:
    return net * FEE_BPS // 10000


def gross_nano(net: int) -> int:
    return net + fee_nano(net)


def gen_code() -> str:
    return os.urandom(4).hex().upper()


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
    q = (query or "").strip().lstrip("@")
    if not q:
        return None
    if q.isdigit():
        return fetchone("SELECT * FROM users WHERE id=?", (int(q),))
    return fetchone("SELECT * FROM users WHERE LOWER(username)=LOWER(?)", (q,))


def uname(uid: int) -> str:
    u = fetchone("SELECT username FROM users WHERE id=?", (uid,))
    return (u.get("username") if u else None) or str(uid)


def clamp_caption(s: str) -> str:
    return s if len(s) <= CAPTION_MAX else s[:CAPTION_MAX - 1] + "…"


# ============================================================================
# TON
# ============================================================================
_mnem, _pub, _priv, wallet = Wallets.from_mnemonics(
    mnemonics=TON_WALLET_MNEMONIC.split(),
    version=WalletVersionEnum.v4r2,
    workchain=0,
)
WALLET_ADDR = wallet.address.to_string(True, True, False)


async def tc_get(endpoint: str, params: dict) -> dict:
    p = dict(params)
    if TONCENTER_API_KEY:
        p["api_key"] = TONCENTER_API_KEY
    async with aiohttp.ClientSession() as s:
        async with s.get(f"https://toncenter.com/api/v2/{endpoint}", params=p, timeout=20) as r:
            return await r.json()


async def tc_post(endpoint: str, body: dict) -> dict:
    params = {"api_key": TONCENTER_API_KEY} if TONCENTER_API_KEY else None
    async with aiohttp.ClientSession() as s:
        async with s.post(f"https://toncenter.com/api/v2/{endpoint}", params=params, json=body, timeout=20) as r:
            return await r.json()


async def get_seqno() -> int:
    j = await tc_get("getWalletInformation", {"address": WALLET_ADDR})
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
    res = await tc_post("sendBoc", {"boc": boc_b64})
    if not res.get("ok"):
        raise RuntimeError(f"sendBoc failed: {res}")
    tx_hash = transfer["message"].bytes_hash().hex()
    for _ in range(30):
        await asyncio.sleep(3)
        if (await get_seqno()) > seqno:
            return tx_hash
    raise RuntimeError("timeout waiting for tx inclusion")


def is_valid_ton_address(s: str) -> bool:
    try:
        Address(s.strip())
        return True
    except Exception:
        return False


# ============================================================================
# FSM СДЕЛКИ
# ============================================================================
ACTIVE_STATUSES = (
    "WAITING_CONFIRMATION", "WAITING_PAYMENT", "PAID", "SELLER_FULFILLED",
    "DISPUTE", "WAITING_PAYOUT_BUYER", "WAITING_PAYOUT_SELLER",
)
TRANSITIONS = {
    "WAITING_CONFIRMATION": {
        "ACCEPT": "WAITING_PAYMENT",
        "REJECT": "CANCELLED",
        "CANCEL_PRE_PAY": "CANCELLED",
    },
    "WAITING_PAYMENT": {
        "PAID": "PAID",
        "CANCEL_PRE_PAY": "CANCELLED",
    },
    "PAID": {
        "SELLER_FULFILLED": "SELLER_FULFILLED",
        "OPEN_DISPUTE": "DISPUTE",
        "CANCEL_AFTER_PAY": "WAITING_PAYOUT_BUYER",
    },
    "SELLER_FULFILLED": {
        "BUYER_CONFIRM": "WAITING_PAYOUT_SELLER",
        "OPEN_DISPUTE": "DISPUTE",
    },
    "DISPUTE": {
        "ADMIN_TO_BUYER": "WAITING_PAYOUT_BUYER",
        "ADMIN_TO_SELLER": "WAITING_PAYOUT_SELLER",
        "ADMIN_CANCEL_DISPUTE": "PAID",  # вернёмся к PAID (упрощение)
    },
    "WAITING_PAYOUT_BUYER": {"PAYOUT_DONE": "REFUNDED"},
    "WAITING_PAYOUT_SELLER": {"PAYOUT_DONE": "COMPLETED"},
}


class CreateDeal(StatesGroup):
    role = State()
    counterparty = State()
    amount = State()
    terms = State()
    summary = State()


class PayoutAddr(StatesGroup):
    enter = State()


async def transition(deal_id: str, action: str, actor_id: Optional[int], **patch) -> Optional[dict]:
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
        [InlineKeyboardButton(text=BTN_PROFILE, callback_data="menu:profile")],
        [InlineKeyboardButton(text=BTN_CREATE_DEAL, callback_data="menu:create")],
        [InlineKeyboardButton(text=BTN_ACTIVE_DEALS, callback_data="menu:active")],
    ])


def back_to_menu_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_BACK, callback_data="menu:main")]
    ])


def profile_kb() -> InlineKeyboardMarkup:
    return back_to_menu_kb()


def wizard_back_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_BACK, callback_data="create:back")]
    ])


def create_role_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_ROLE_BUYER, callback_data="create:role:buyer"),
         InlineKeyboardButton(text=BTN_ROLE_SELLER, callback_data="create:role:seller")],
        [InlineKeyboardButton(text=BTN_BACK, callback_data="menu:main")],
    ])


def create_summary_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_CONFIRM, callback_data="create:confirm")],
        [InlineKeyboardButton(text=BTN_BACK, callback_data="create:back")],
    ])


def new_deal_notify_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_ACCEPT_DEAL, callback_data=f"deal:{deal_id}:accept"),
         InlineKeyboardButton(text=BTN_REJECT_DEAL, callback_data=f"deal:{deal_id}:reject:yes")],
    ])


def open_deal_only_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_OPEN_DEAL, callback_data=f"deal:{deal_id}:open")],
    ])


STATUS_LABELS = {
    "WAITING_CONFIRMATION": "Ожидание подтверждения",
    "WAITING_PAYMENT": "Ожидание оплаты",
    "PAID": "Оплачено",
    "SELLER_FULFILLED": "Условия выполнены продавцом",
    "DISPUTE": "Спор",
    "WAITING_PAYOUT_BUYER": "Возврат покупателю",
    "WAITING_PAYOUT_SELLER": "Выплата продавцу",
    "CANCELLED": "Отменено",
    "COMPLETED": "Завершено",
    "REFUNDED": "Возвращено",
}


def active_deals_kb(deals: list[dict], me_id: int) -> InlineKeyboardMarkup:
    rows = []
    for d in deals:
        role = ROLE_BUYER if d["buyer_id"] == me_id else ROLE_SELLER
        rows.append([InlineKeyboardButton(
            text=f"#{d['code']} · {role} · {STATUS_LABELS.get(d['status'], d['status'])}",
            callback_data=f"deal:{d['id']}:open",
        )])
    rows.append([InlineKeyboardButton(text=BTN_BACK, callback_data="menu:main")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def confirm_reject_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_YES, callback_data=f"deal:{deal_id}:reject:yes"),
         InlineKeyboardButton(text=BTN_NO, callback_data=f"deal:{deal_id}:open")],
    ])


def confirm_cancel_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_YES, callback_data=f"deal:{deal_id}:cancel:yes"),
         InlineKeyboardButton(text=BTN_NO, callback_data=f"deal:{deal_id}:open")],
    ])


def confirm_cancel_paid_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_YES, callback_data=f"deal:{deal_id}:cancelpaid:yes"),
         InlineKeyboardButton(text=BTN_NO, callback_data=f"deal:{deal_id}:open")],
    ])


def confirm_buyer_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_YES, callback_data=f"deal:{deal_id}:buyerconfirm:yes"),
         InlineKeyboardButton(text=BTN_NO, callback_data=f"deal:{deal_id}:open")],
    ])


def payment_kb(deal_id: str) -> InlineKeyboardMarkup:
    # Только кнопка «Назад» — оплаты пуллятся автоматически watcher-ом.
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_BACK, callback_data=f"deal:{deal_id}:open")],
    ])


def payout_back_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_BACK, callback_data=f"deal:{deal_id}:open")],
    ])


def admin_dispute_kb(deal_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=BTN_ADMIN_TO_BUYER, callback_data=f"admin:{deal_id}:buyer")],
        [InlineKeyboardButton(text=BTN_ADMIN_TO_SELLER, callback_data=f"admin:{deal_id}:seller")],
        [InlineKeyboardButton(text=BTN_ADMIN_CANCEL_DISPUTE, callback_data=f"admin:{deal_id}:cancel")],
    ])


def deal_menu_kb(deal: dict, uid: int) -> InlineKeyboardMarkup:
    st = deal["status"]
    is_buyer = uid == deal["buyer_id"]
    is_seller = uid == deal["seller_id"]
    did = deal["id"]
    rows: list[list[InlineKeyboardButton]] = []
    if st == "WAITING_CONFIRMATION":
        if uid == deal["counterparty_id"]:
            rows.append([InlineKeyboardButton(text=BTN_ACCEPT_DEAL, callback_data=f"deal:{did}:accept")])
            rows.append([InlineKeyboardButton(text=BTN_REJECT_DEAL, callback_data=f"deal:{did}:reject:yes")])
        else:
            rows.append([InlineKeyboardButton(text=BTN_CANCEL_DEAL, callback_data=f"deal:{did}:cancel:ask")])
    elif st == "WAITING_PAYMENT":
        if is_buyer:
            rows.append([InlineKeyboardButton(text=BTN_PAY, callback_data=f"deal:{did}:pay")])
            rows.append([InlineKeyboardButton(text=BTN_CANCEL_DEAL, callback_data=f"deal:{did}:cancel:ask")])
    elif st == "PAID":
        if is_seller:
            rows.append([InlineKeyboardButton(text=BTN_SELLER_FULFILLED, callback_data=f"deal:{did}:fulfilled")])
            rows.append([InlineKeyboardButton(text=BTN_CANCEL_DEAL, callback_data=f"deal:{did}:cancelpaid:ask")])
        if is_buyer:
            rows.append([InlineKeyboardButton(text=BTN_OPEN_DISPUTE, callback_data=f"deal:{did}:dispute")])
    elif st == "SELLER_FULFILLED":
        if is_buyer:
            rows.append([InlineKeyboardButton(text=BTN_BUYER_CONFIRM, callback_data=f"deal:{did}:buyerconfirm:ask")])
        rows.append([InlineKeyboardButton(text=BTN_OPEN_DISPUTE, callback_data=f"deal:{did}:dispute")])
    elif st == "DISPUTE":
        if is_buyer:
            rows.append([InlineKeyboardButton(text=BTN_CONCEDE, callback_data=f"deal:{did}:concede:seller")])
        elif is_seller:
            rows.append([InlineKeyboardButton(text=BTN_CONCEDE, callback_data=f"deal:{did}:concede:buyer")])
    elif st == "WAITING_PAYOUT_BUYER" and is_buyer:
        rows.append([InlineKeyboardButton(text=BTN_GET_FUNDS, callback_data=f"deal:{did}:payout")])
    elif st == "WAITING_PAYOUT_SELLER" and is_seller:
        rows.append([InlineKeyboardButton(text=BTN_GET_FUNDS, callback_data=f"deal:{did}:payout")])
    rows.append([InlineKeyboardButton(text=BTN_BACK, callback_data="menu:main")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


# ============================================================================
# БАННЕР
# ============================================================================
_banner_file_id: Optional[str] = None
bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.MARKDOWN))
dp = Dispatcher(storage=MemoryStorage())
router = Router()
dp.include_router(router)


async def send_banner(chat_id: int, caption: str, kb: Optional[InlineKeyboardMarkup] = None) -> Message:
    global _banner_file_id
    photo = _banner_file_id if _banner_file_id else FSInputFile(BANNER_PATH)
    msg = await bot.send_photo(chat_id, photo, caption=clamp_caption(caption), reply_markup=kb)
    if not _banner_file_id and msg.photo:
        _banner_file_id = msg.photo[-1].file_id
    return msg


async def edit_banner(msg: Message, caption: str, kb: Optional[InlineKeyboardMarkup] = None):
    try:
        if msg.photo:
            await msg.edit_caption(caption=clamp_caption(caption), reply_markup=kb)
        else:
            # сообщение не фото — удалим и пришлём свежий баннер
            try:
                await msg.delete()
            except Exception:
                pass
            await send_banner(msg.chat.id, caption, kb)
    except TelegramBadRequest as e:
        if "message is not modified" in str(e):
            return
        try:
            await msg.delete()
        except Exception:
            pass
        await send_banner(msg.chat.id, caption, kb)


async def safe_send_msg(chat_id: int, text: str, kb: Optional[InlineKeyboardMarkup] = None):
    try:
        await bot.send_message(chat_id, text, reply_markup=kb)
    except Exception as e:
        log.warning(f"send to {chat_id} failed: {e}")


# ============================================================================
# КАРТОЧКА СДЕЛКИ
# ============================================================================
def role_for(deal: dict, uid: int) -> str:
    return ROLE_BUYER if uid == deal["buyer_id"] else ROLE_SELLER


def build_deal_card(deal: dict, uid: int) -> str:
    is_buyer = uid == deal["buyer_id"]
    role = ROLE_BUYER if is_buyer else ROLE_SELLER
    role_key = "buyer" if is_buyer else "seller"
    if deal["status"] == "WAITING_CONFIRMATION":
        if uid == deal["creator_id"]:
            opp = ROLE_BY_SELLER if is_buyer else ROLE_BY_BUYER
            intro = f"ℹ️ *Ожидаете подтверждения сделки {opp}.*"
        else:
            intro = "ℹ️ *У вас новое предложение о сделке. Примите или отклоните его.*"
    else:
        intro = CARD_INTRO.get((deal["status"], role_key), "")
    return t_deal_card(
        intro=intro,
        role=role,
        amount=nano_to_ton(deal["amount_nano"]),
        to_pay=nano_to_ton(gross_nano(deal["amount_nano"])),
        terms=deal["terms"],
    )


async def render_deal_card(target_msg: Message, deal: dict, uid: int):
    await edit_banner(target_msg, build_deal_card(deal, uid), deal_menu_kb(deal, uid))


# ============================================================================
# ХЭНДЛЕРЫ
# ============================================================================
@router.message(CommandStart())
async def cmd_start(m: Message, state: FSMContext):
    await state.clear()
    get_or_create_user(m.from_user.id, m.from_user.username)
    await send_banner(m.chat.id, MAIN_MENU, main_menu_kb())


@router.message(Command("cancel"))
async def cmd_cancel(m: Message, state: FSMContext):
    await state.clear()
    await send_banner(m.chat.id, CREATE_CANCELLED, main_menu_kb())


@router.callback_query(F.data == "menu:main")
async def cb_menu_main(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    await state.clear()
    await edit_banner(c.message, MAIN_MENU, main_menu_kb())
    await c.answer()


@router.callback_query(F.data == "menu:profile")
async def cb_profile(c: CallbackQuery):
    if callback_seen(c.id):
        return
    u = get_or_create_user(c.from_user.id, c.from_user.username)
    await edit_banner(c.message, t_profile_stats(
        username=u.get("username") or "",
        completed=u["completed_count"],
        cancelled=u["cancelled_count"],
        disputes=u["dispute_count"],
    ), profile_kb())
    await c.answer()


@router.callback_query(F.data == "menu:active")
async def cb_active(c: CallbackQuery):
    if callback_seen(c.id):
        return
    uid = c.from_user.id
    deals = fetchall(
        "SELECT * FROM deals WHERE (buyer_id=? OR seller_id=?) AND status IN "
        "('WAITING_CONFIRMATION','WAITING_PAYMENT','PAID','SELLER_FULFILLED','DISPUTE',"
        " 'WAITING_PAYOUT_BUYER','WAITING_PAYOUT_SELLER') ORDER BY created_at DESC LIMIT 20",
        (uid, uid),
    )
    if not deals:
        await edit_banner(c.message, NO_ACTIVE_DEALS, back_to_menu_kb())
        await c.answer()
        return
    await edit_banner(c.message, ACTIVE_DEALS_TITLE, active_deals_kb(deals, uid))
    await c.answer()


# ----- Создание сделки
@router.callback_query(F.data == "menu:create")
async def cb_create(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    uid = c.from_user.id
    get_or_create_user(uid, c.from_user.username)
    cnt = fetchone(
        "SELECT COUNT(*) c FROM deals WHERE (buyer_id=? OR seller_id=?) AND status IN "
        "('WAITING_CONFIRMATION','WAITING_PAYMENT','PAID','SELLER_FULFILLED','DISPUTE',"
        " 'WAITING_PAYOUT_BUYER','WAITING_PAYOUT_SELLER')",
        (uid, uid),
    )
    if cnt and cnt["c"] >= DEAL_LIMIT_PER_USER:
        await edit_banner(c.message, t_active_limit_reached(DEAL_LIMIT_PER_USER), back_to_menu_kb())
        await c.answer()
        return
    await state.set_state(CreateDeal.role)
    await edit_banner(c.message, CREATE_CHOOSE_ROLE, create_role_kb())
    await c.answer()


@router.callback_query(F.data.startswith("create:role:"), CreateDeal.role)
async def cb_create_role(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    role = c.data.split(":", 2)[2]
    await state.update_data(role=role, prompt_msg_id=c.message.message_id)
    await state.set_state(CreateDeal.counterparty)
    await edit_banner(c.message, CREATE_ASK_COUNTERPARTY, wizard_back_kb())
    await c.answer()


@router.callback_query(F.data == "create:back")
async def cb_create_back(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    cur = await state.get_state()
    data = await state.get_data()
    if cur == CreateDeal.counterparty.state:
        await state.set_state(CreateDeal.role)
        await edit_banner(c.message, CREATE_CHOOSE_ROLE, create_role_kb())
    elif cur == CreateDeal.amount.state:
        await state.set_state(CreateDeal.counterparty)
        await edit_banner(c.message, CREATE_ASK_COUNTERPARTY, wizard_back_kb())
    elif cur == CreateDeal.terms.state:
        await state.set_state(CreateDeal.amount)
        await edit_banner(c.message, CREATE_ASK_AMOUNT, wizard_back_kb())
    elif cur == CreateDeal.summary.state:
        await state.set_state(CreateDeal.terms)
        await edit_banner(c.message, CREATE_ASK_TERMS, wizard_back_kb())
    else:
        await state.clear()
        await edit_banner(c.message, MAIN_MENU, main_menu_kb())
    await state.update_data(prompt_msg_id=c.message.message_id)
    await c.answer()


async def _respond_to_input(m: Message, state: FSMContext, text: str, kb: Optional[InlineKeyboardMarkup]):
    # Удаляем пользовательский ввод и редактируем prompt-сообщение бота
    try:
        await m.delete()
    except Exception:
        pass
    data = await state.get_data()
    prompt_id = data.get("prompt_msg_id")
    if prompt_id:
        try:
            await bot.edit_message_caption(
                chat_id=m.chat.id,
                message_id=prompt_id,
                caption=clamp_caption(text),
                reply_markup=kb,
            )
            return
        except TelegramBadRequest as e:
            if "message is not modified" in str(e):
                return
    msg = await send_banner(m.chat.id, text, kb)
    await state.update_data(prompt_msg_id=msg.message_id)


@router.message(CreateDeal.counterparty)
async def m_cp(m: Message, state: FSMContext):
    target = find_user(m.text or "")
    if not target:
        await _respond_to_input(m, state, COUNTERPARTY_NOT_FOUND, wizard_back_kb())
        return
    if target["id"] == m.from_user.id:
        await _respond_to_input(m, state, COUNTERPARTY_IS_SELF, wizard_back_kb())
        return
    await state.update_data(other_id=target["id"], other_username=target.get("username") or "")
    await state.set_state(CreateDeal.amount)
    await _respond_to_input(m, state, CREATE_ASK_AMOUNT, wizard_back_kb())


@router.message(CreateDeal.amount)
async def m_amount(m: Message, state: FSMContext):
    try:
        n = float((m.text or "").strip().replace(",", "."))
        if not (0.1 <= n <= 1_000_000):
            raise ValueError
    except Exception:
        await _respond_to_input(m, state, INVALID_AMOUNT, wizard_back_kb())
        return
    await state.update_data(amount_nano=ton_to_nano(n))
    await state.set_state(CreateDeal.terms)
    await _respond_to_input(m, state, CREATE_ASK_TERMS, wizard_back_kb())


@router.message(CreateDeal.terms)
async def m_terms(m: Message, state: FSMContext):
    text = (m.text or "").strip()
    if not text:
        await _respond_to_input(m, state, CREATE_ASK_TERMS, wizard_back_kb())
        return
    if len(text) > 2000:
        await _respond_to_input(m, state, TERMS_TOO_LONG, wizard_back_kb())
        return
    data = await state.get_data()
    await state.update_data(terms=text)
    await state.set_state(CreateDeal.summary)
    role_word = ROLE_BUYER if data["role"] == "buyer" else ROLE_SELLER
    await _respond_to_input(
        m, state,
        t_create_summary(
            role=role_word,
            amount=nano_to_ton(data["amount_nano"]),
            to_pay=nano_to_ton(gross_nano(data["amount_nano"])),
            terms=text,
        ),
        create_summary_kb(),
    )


@router.callback_query(F.data == "create:confirm", CreateDeal.summary)
async def cb_create_confirm(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    data = await state.get_data()
    uid = c.from_user.id
    cnt = fetchone(
        "SELECT COUNT(*) c FROM deals WHERE (buyer_id=? OR seller_id=?) AND status IN "
        "('WAITING_CONFIRMATION','WAITING_PAYMENT','PAID','SELLER_FULFILLED','DISPUTE',"
        " 'WAITING_PAYOUT_BUYER','WAITING_PAYOUT_SELLER')",
        (uid, uid),
    )
    if cnt and cnt["c"] >= DEAL_LIMIT_PER_USER:
        await edit_banner(c.message, t_active_limit_reached(DEAL_LIMIT_PER_USER), back_to_menu_kb())
        await state.clear()
        await c.answer()
        return
    if data["role"] == "buyer":
        buyer, seller = uid, data["other_id"]
    else:
        buyer, seller = data["other_id"], uid
    did = str(uuid.uuid4())
    code = gen_code()
    execute(
        "INSERT INTO deals(id, code, creator_id, counterparty_id, buyer_id, seller_id, "
        "amount_nano, terms, status) VALUES(?,?,?,?,?,?,?,?, 'WAITING_CONFIRMATION')",
        (did, code, uid, data["other_id"], buyer, seller, data["amount_nano"], data["terms"]),
    )
    execute("INSERT INTO deal_events(deal_id, event_type, actor_id) VALUES(?,?,?)",
            (did, "CREATED", uid))
    deal = fetchone("SELECT * FROM deals WHERE id=?", (did,))
    opp_role_by_creator = ROLE_BY_SELLER if data["role"] == "buyer" else ROLE_BY_BUYER
    await state.clear()
    await edit_banner(c.message, t_create_sent(opp_role_by_creator), open_deal_only_kb(deal["id"]))
    # Уведомление второй стороне — баннером
    cp_role = ROLE_SELLER if data["role"] == "buyer" else ROLE_BUYER
    try:
        await send_banner(
            data["other_id"],
            t_notif_new_deal(
                role=cp_role,
                amount=nano_to_ton(deal["amount_nano"]),
                to_pay=nano_to_ton(gross_nano(deal["amount_nano"])),
                terms=deal["terms"],
            ),
            new_deal_notify_kb(deal["id"]),
        )
    except Exception as e:
        log.warning(f"notify counterparty {data['other_id']} failed: {e}")
    await c.answer()


# ----- Открыть сделку
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):open$"))
async def cb_deal_open(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    deal = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not deal:
        await c.answer()
        return
    if c.from_user.id not in (deal["buyer_id"], deal["seller_id"]):
        await c.answer()
        return
    await state.clear()
    await render_deal_card(c.message, deal, c.from_user.id)
    await c.answer()


# ----- Accept
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):accept$"))
async def cb_deal_accept(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    r = await transition(deal_id, "ACCEPT", c.from_user.id)
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    try:
        await c.message.delete()
    except Exception:
        pass
    await send_banner(c.from_user.id, DEAL_ACCEPTED, open_deal_only_kb(r["id"]))
    creator_id = r["creator_id"]
    if creator_id != c.from_user.id:
        await safe_send_msg(creator_id, DEAL_ACCEPTED, open_deal_only_kb(r["id"]))
    await c.answer()


# ----- Reject
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):reject:ask$"))
async def cb_deal_reject_ask(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    await edit_banner(c.message, CONFIRM_REJECT_DEAL, confirm_reject_kb(deal_id))
    await c.answer()


@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):reject:yes$"))
async def cb_deal_reject_yes(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    deal_before = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not deal_before:
        await c.answer()
        return
    r = await transition(deal_id, "REJECT", c.from_user.id)
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    execute("UPDATE users SET cancelled_count=cancelled_count+1 WHERE id IN (?,?)",
            (r["buyer_id"], r["seller_id"]))
    other = r["creator_id"] if r["creator_id"] != c.from_user.id else r["counterparty_id"]
    try:
        await c.message.delete()
    except Exception:
        pass
    await state.clear()
    await send_banner(c.from_user.id, MAIN_MENU, main_menu_kb())
    await safe_send_msg(other, DEAL_REJECTED_BY_CP)
    await c.answer()


# ----- Cancel pre-pay
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):cancel:ask$"))
async def cb_cancel_ask(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    await edit_banner(c.message, CANCEL_CONFIRM, confirm_cancel_kb(deal_id))
    await c.answer()


@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):cancel:yes$"))
async def cb_cancel_yes(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    r = await transition(deal_id, "CANCEL_PRE_PAY", c.from_user.id)
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    execute("UPDATE users SET cancelled_count=cancelled_count+1 WHERE id IN (?,?)",
            (r["buyer_id"], r["seller_id"]))
    other = r["seller_id"] if c.from_user.id == r["buyer_id"] else r["buyer_id"]
    await edit_banner(c.message, DEAL_CANCELLED, back_to_menu_kb())
    await safe_send_msg(other, DEAL_CANCELLED)
    await c.answer()


# ----- Pay screen
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):pay$"))
async def cb_pay(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    deal = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not deal or deal["buyer_id"] != c.from_user.id or deal["status"] != "WAITING_PAYMENT":
        await c.answer()
        return
    await edit_banner(
        c.message,
        t_pay_instructions(
            address=WALLET_ADDR,
            amount=nano_to_ton(gross_nano(deal["amount_nano"])),
            code=deal["code"],
        ),
        payment_kb(deal_id),
    )
    await c.answer()


# ----- Seller cancel after pay
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):cancelpaid:ask$"))
async def cb_cancelpaid_ask(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    await edit_banner(c.message, CANCEL_CONFIRM, confirm_cancel_paid_kb(deal_id))
    await c.answer()


@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):cancelpaid:yes$"))
async def cb_cancelpaid_yes(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    r = await transition(deal_id, "CANCEL_AFTER_PAY", c.from_user.id, payout_to_user_id=None)
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    # Покупатель получает возможность забрать средства
    execute("UPDATE deals SET payout_to_user_id=? WHERE id=?", (r["buyer_id"], r["id"]))
    r = fetchone("SELECT * FROM deals WHERE id=?", (r["id"],))
    await edit_banner(c.message, DEAL_CANCELLED, back_to_menu_kb())
    await safe_send_msg(r["buyer_id"], DEAL_CANCELLED_SELLER_AFTER_PAY, open_deal_only_kb(r["id"]))
    await c.answer()


# ----- Seller fulfilled
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):fulfilled$"))
async def cb_fulfilled(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    r = await transition(deal_id, "SELLER_FULFILLED", c.from_user.id)
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    await render_deal_card(c.message, r, c.from_user.id)
    await safe_send_msg(
        r["buyer_id"], SELLER_FULFILLED_BUYER,
        InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text=BTN_OPEN_DEAL, callback_data=f"deal:{r['id']}:open")]
        ]),
    )
    await c.answer()


# ----- Buyer confirm
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):buyerconfirm:ask$"))
async def cb_buyerconfirm_ask(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    await edit_banner(c.message, BUYER_CONFIRM_PROMPT, confirm_buyer_kb(deal_id))
    await c.answer()


@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):buyerconfirm:yes$"))
async def cb_buyerconfirm_yes(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    r = await transition(deal_id, "BUYER_CONFIRM", c.from_user.id, payout_to_user_id=None)
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    execute("UPDATE deals SET payout_to_user_id=? WHERE id=?", (r["seller_id"], r["id"]))
    r = fetchone("SELECT * FROM deals WHERE id=?", (r["id"],))
    execute("UPDATE users SET completed_count=completed_count+1 WHERE id=?", (r["buyer_id"],))
    await edit_banner(c.message, DEAL_COMPLETED, back_to_menu_kb())
    await safe_send_msg(r["seller_id"], PAYOUT_READY_SELLER,
                        deal_menu_kb(r, r["seller_id"]))
    await c.answer()


# ----- Open dispute
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):dispute$"))
async def cb_dispute(c: CallbackQuery):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    before = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not before:
        await c.answer()
        return
    r = await transition(deal_id, "OPEN_DISPUTE", c.from_user.id,
                         dispute_opened_by=c.from_user.id,
                         previous_status=before["status"])
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    execute("UPDATE users SET dispute_count=dispute_count+1 WHERE id IN (?,?)",
            (r["buyer_id"], r["seller_id"]))
    await render_deal_card(c.message, r, c.from_user.id)
    other = r["seller_id"] if c.from_user.id == r["buyer_id"] else r["buyer_id"]
    await safe_send_msg(other, DISPUTE_OPENED, deal_menu_kb(r, other))
    await safe_send_msg(
        ADMIN_CHAT_ID,
        t_admin_dispute_panel(
            code=r["code"],
            buyer=uname(r["buyer_id"]),
            seller=uname(r["seller_id"]),
            amount=nano_to_ton(r["amount_nano"]),
            terms=r["terms"],
        ),
        admin_dispute_kb(r["id"]),
    )
    await c.answer()


# ----- Voluntary concede
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):concede:(buyer|seller)$"))
async def cb_concede(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    parts = c.data.split(":")
    deal_id, to_who = parts[1], parts[3]
    deal = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not deal or deal["status"] != "DISPUTE":
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    uid = c.from_user.id
    valid = (to_who == "buyer" and uid == deal["seller_id"]) or \
            (to_who == "seller" and uid == deal["buyer_id"])
    if not valid:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    action = "ADMIN_TO_BUYER" if to_who == "buyer" else "ADMIN_TO_SELLER"
    payout_to = deal["buyer_id"] if to_who == "buyer" else deal["seller_id"]
    r = await transition(deal_id, action, uid, payout_to_user_id=payout_to)
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    await _notify_dispute_resolved(r, to_who)
    await state.clear()
    await edit_banner(c.message, MAIN_MENU, main_menu_kb())
    await c.answer()


async def _notify_dispute_resolved(deal: dict, to_who: str):
    winner = deal["buyer_id"] if to_who == "buyer" else deal["seller_id"]
    loser = deal["seller_id"] if to_who == "buyer" else deal["buyer_id"]
    if to_who == "buyer":
        await safe_send_msg(winner, PAYOUT_READY_BUYER, deal_menu_kb(deal, winner))
    else:
        await safe_send_msg(winner, PAYOUT_READY_SELLER, deal_menu_kb(deal, winner))
    await safe_send_msg(loser, f"⚖️ Спор #{deal['code']} решён в пользу оппонента.",
                        deal_menu_kb(deal, loser))


# ----- Admin: dispute resolution
@router.callback_query(F.data.regexp(r"^admin:([0-9a-f-]+):(buyer|seller|cancel)$"))
async def cb_admin(c: CallbackQuery):
    if c.message.chat.id != ADMIN_CHAT_ID:
        await c.answer("Нет доступа", show_alert=True)
        return
    if callback_seen(c.id):
        return
    parts = c.data.split(":")
    deal_id, decision = parts[1], parts[2]
    deal = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not deal or deal["status"] != "DISPUTE":
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    if decision == "cancel":
        r = await transition(deal_id, "ADMIN_CANCEL_DISPUTE", None)
        if not r:
            await c.answer(INVALID_ACTION, show_alert=True)
            return
        await c.message.answer(DISPUTE_CANCELLED)
        await safe_send_msg(r["buyer_id"], DISPUTE_CANCELLED, deal_menu_kb(r, r["buyer_id"]))
        await safe_send_msg(r["seller_id"], DISPUTE_CANCELLED, deal_menu_kb(r, r["seller_id"]))
        await c.answer()
        return
    action = "ADMIN_TO_BUYER" if decision == "buyer" else "ADMIN_TO_SELLER"
    payout_to = deal["buyer_id"] if decision == "buyer" else deal["seller_id"]
    r = await transition(deal_id, action, None, payout_to_user_id=payout_to)
    if not r:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    await _notify_dispute_resolved(r, decision)
    try:
        await c.message.edit_reply_markup(reply_markup=None)
    except Exception:
        pass
    await c.answer("Решение применено")


# ----- Payout: ask address
@router.callback_query(F.data.regexp(r"^deal:([0-9a-f-]+):payout$"))
async def cb_payout(c: CallbackQuery, state: FSMContext):
    if callback_seen(c.id):
        return
    deal_id = c.data.split(":")[1]
    deal = fetchone("SELECT * FROM deals WHERE id=?", (deal_id,))
    if not deal:
        await c.answer()
        return
    uid = c.from_user.id
    allowed = (deal["status"] == "WAITING_PAYOUT_BUYER" and uid == deal["buyer_id"]) or \
              (deal["status"] == "WAITING_PAYOUT_SELLER" and uid == deal["seller_id"])
    if not allowed:
        await c.answer(INVALID_ACTION, show_alert=True)
        return
    await state.set_state(PayoutAddr.enter)
    await state.update_data(deal_id=deal_id, prompt_msg_id=c.message.message_id)
    await edit_banner(c.message, PAYOUT_ASK_ADDRESS, payout_back_kb(deal_id))
    await c.answer()


@router.message(PayoutAddr.enter)
async def m_payout(m: Message, state: FSMContext):
    addr = (m.text or "").strip()
    if not is_valid_ton_address(addr):
        await _respond_to_input(m, state, PAYOUT_INVALID_ADDRESS, None)
        return
    data = await state.get_data()
    deal = fetchone("SELECT * FROM deals WHERE id=?", (data.get("deal_id"),))
    if not deal:
        await state.clear()
        return
    try:
        await m.delete()
    except Exception:
        pass
    prompt_id = data.get("prompt_msg_id")
    await state.clear()

    # Считаем сумму
    net = deal["amount_nano"]
    fee = fee_nano(net)
    if deal["status"] == "WAITING_PAYOUT_SELLER":
        payout = net - GAS_RESERVE_NANO
        send_fee = True
        show_amount = nano_to_ton(net)
    elif deal["status"] == "WAITING_PAYOUT_BUYER":
        # При возврате возвращаем то, что покупатель заплатил (gross)
        payout = gross_nano(net) - GAS_RESERVE_NANO
        send_fee = False
        show_amount = nano_to_ton(gross_nano(net))
    else:
        return

    # Покажем "Отправляю..."
    if prompt_id:
        try:
            await bot.edit_message_caption(
                chat_id=m.chat.id, message_id=prompt_id,
                caption=clamp_caption(t_payout_processing(address=addr, amount=show_amount)),
                reply_markup=None,
            )
        except Exception:
            pass

    try:
        tx_hash = await send_ton(addr, payout, comment=f"escrow {deal['code']}")
    except Exception as e:
        log.exception("payout failed")
        if prompt_id:
            try:
                await bot.edit_message_caption(
                    chat_id=m.chat.id, message_id=prompt_id,
                    caption=clamp_caption(PAYOUT_FAILED),
                    reply_markup=back_to_menu_kb(),
                )
            except Exception:
                pass
        return

    r = await transition(
        deal["id"], "PAYOUT_DONE", m.from_user.id,
        payout_tx_hash=tx_hash, payout_address=addr,
    )
    if r and r["status"] == "COMPLETED":
        execute("UPDATE users SET completed_count=completed_count+1 WHERE id=?", (r["seller_id"],))

    result = t_payout_sent(
        amount=show_amount, address=addr,
        explorer=f"https://tonviewer.com/{addr}",
    )
    if prompt_id:
        try:
            await bot.edit_message_caption(
                chat_id=m.chat.id, message_id=prompt_id,
                caption=clamp_caption(result),
                reply_markup=back_to_menu_kb(),
            )
        except Exception:
            await send_banner(m.chat.id, result, back_to_menu_kb())
    else:
        await send_banner(m.chat.id, result, back_to_menu_kb())

    # Отправляем комиссию на FEE_WALLET (только при выплате продавцу)
    if send_fee:
        fee_amount = fee - GAS_RESERVE_NANO
        if fee_amount > 0:
            try:
                fee_tx = await send_ton(FEE_WALLET, fee_amount, comment=f"fee {deal['code']}")
                log.info(f"fee {nano_to_ton(fee_amount)} TON sent to {FEE_WALLET}")
                await safe_send_msg(
                    ADMIN_CHAT_ID,
                    f"💰 Комиссия по сделке #{deal['code']}: {nano_to_ton(fee_amount)} TON\n"
                    f"→ {FEE_WALLET}\nTX: `{fee_tx}`",
                )
            except Exception as e:
                log.exception("fee transfer failed")
                await safe_send_msg(
                    ADMIN_CHAT_ID,
                    f"⚠️ Не удалось отправить комиссию по сделке #{deal['code']}: {str(e)[:200]}",
                )


# ============================================================================
# WATCHER ВХОДЯЩИХ ПЛАТЕЖЕЙ
# ============================================================================
async def payment_watcher():
    log.info("payment watcher started")
    while True:
        try:
            j = await tc_get("getTransactions",
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
                expected = gross_nano(deal["amount_nano"])
                if value < expected:
                    log.warning(f"tx {tx_hash[:10]} amount {value} < expected {expected}")
                    continue
                r = await transition(deal["id"], "PAID", 0, payment_tx_hash=tx_hash)
                if r:
                    log.info(f"deal {deal['code']} -> PAID via {tx_hash[:10]}")
                    await safe_send_msg(
                        r["buyer_id"],
                        "ℹ️ *Вы оплатили сделку. Продавец может приступать к выполнению условий.*",
                        deal_menu_kb(r, r["buyer_id"]),
                    )
                    await safe_send_msg(
                        r["seller_id"],
                        "ℹ️ *Покупатель оплатил сделку. Можете приступать к выполнению условий.*",
                        deal_menu_kb(r, r["seller_id"]),
                    )
                    await safe_send_msg(
                        ADMIN_CHAT_ID,
                        t_admin_log_paid(
                            code=r["code"],
                            amount=nano_to_ton(r["amount_nano"]),
                            seller=uname(r["seller_id"]),
                            buyer=uname(r["buyer_id"]),
                            terms=r["terms"],
                        ),
                    )
        except Exception as e:
            log.warning(f"watcher error: {e}")
        await asyncio.sleep(WATCHER_INTERVAL_S)


# ============================================================================
# MAIN
# ============================================================================
async def main():
    db_init()
    log.info(f"TON wallet address: {WALLET_ADDR}")
    log.info(f"Fee wallet: {FEE_WALLET}")
    log.info(f"Banner: {BANNER_PATH} (exists={os.path.exists(BANNER_PATH)})")
    asyncio.create_task(payment_watcher())
    me = await bot.get_me()
    log.info(f"Bot started: @{me.username}")
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())


if __name__ == "__main__":
    asyncio.run(main())
