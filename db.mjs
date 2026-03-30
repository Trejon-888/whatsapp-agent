import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const DB_PATH = resolve(process.cwd(), "data", "agent.db");

// Ensure data directory
const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    platform TEXT DEFAULT 'whatsapp',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    tags TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
    text TEXT NOT NULL,
    platform TEXT DEFAULT 'whatsapp',
    platform_msg_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    context TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
`);

// Prepared statements
const stmts = {
  upsertContact: db.prepare(`
    INSERT INTO contacts (phone, name, platform, first_seen, last_seen, message_count)
    VALUES (@phone, @name, @platform, @now, @now, 1)
    ON CONFLICT(phone) DO UPDATE SET
      name = COALESCE(@name, contacts.name),
      last_seen = @now,
      message_count = contacts.message_count + 1
  `),

  getContact: db.prepare("SELECT * FROM contacts WHERE phone = ?"),
  getContactById: db.prepare("SELECT * FROM contacts WHERE id = ?"),

  addMessage: db.prepare(`
    INSERT INTO messages (contact_id, direction, text, platform, platform_msg_id, created_at)
    VALUES (@contact_id, @direction, @text, @platform, @platform_msg_id, @created_at)
  `),

  getHistory: db.prepare(`
    SELECT direction, text, created_at FROM messages
    WHERE contact_id = ? ORDER BY created_at DESC LIMIT ?
  `),

  addEscalation: db.prepare(`
    INSERT INTO escalations (contact_id, reason, context, created_at)
    VALUES (@contact_id, @reason, @context, @created_at)
  `),

  // Dashboard queries
  recentConversations: db.prepare(`
    SELECT c.id, c.phone, c.name, c.platform, c.last_seen, c.message_count,
           (SELECT text FROM messages WHERE contact_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
    FROM contacts c ORDER BY c.last_seen DESC LIMIT ?
  `),

  conversationMessages: db.prepare(`
    SELECT direction, text, created_at FROM messages
    WHERE contact_id = ? ORDER BY created_at ASC
  `),

  openEscalations: db.prepare(`
    SELECT e.*, c.phone, c.name FROM escalations e
    JOIN contacts c ON c.id = e.contact_id
    WHERE e.status = 'open' ORDER BY e.created_at DESC
  `),

  resolveEscalation: db.prepare(`
    UPDATE escalations SET status = 'resolved', resolved_at = ? WHERE id = ?
  `),

  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM contacts) as total_contacts,
      (SELECT COUNT(*) FROM messages WHERE created_at > date('now', '-1 day')) as messages_today,
      (SELECT COUNT(*) FROM messages WHERE direction = 'in' AND created_at > date('now', '-1 day')) as inbound_today,
      (SELECT COUNT(*) FROM escalations WHERE status = 'open') as open_escalations,
      (SELECT COUNT(DISTINCT contact_id) FROM messages WHERE created_at > date('now', '-1 day')) as active_today
  `),

  dailySummary: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages WHERE direction = 'in' AND created_at > @since) as inbound,
      (SELECT COUNT(*) FROM messages WHERE direction = 'out' AND created_at > @since) as outbound,
      (SELECT COUNT(DISTINCT contact_id) FROM messages WHERE created_at > @since) as unique_contacts,
      (SELECT COUNT(*) FROM escalations WHERE created_at > @since) as escalations,
      (SELECT COUNT(*) FROM contacts WHERE first_seen > @since) as new_contacts
  `),
};

// Helper functions
export function recordIncoming(phone, name, text, platform = "whatsapp", msgId = null) {
  const now = new Date().toISOString();
  stmts.upsertContact.run({ phone, name, platform, now });
  const contact = stmts.getContact.get(phone);
  stmts.addMessage.run({
    contact_id: contact.id,
    direction: "in",
    text,
    platform,
    platform_msg_id: msgId,
    created_at: now,
  });
  return contact;
}

export function recordOutgoing(phone, text, platform = "whatsapp") {
  const now = new Date().toISOString();
  const contact = stmts.getContact.get(phone);
  if (!contact) return;
  stmts.addMessage.run({
    contact_id: contact.id,
    direction: "out",
    text,
    platform,
    platform_msg_id: null,
    created_at: now,
  });
}

export function recordEscalation(phone, reason, context) {
  const now = new Date().toISOString();
  const contact = stmts.getContact.get(phone);
  if (!contact) return;
  stmts.addEscalation.run({
    contact_id: contact.id,
    reason,
    context,
    created_at: now,
  });
}

export function getConversationHistory(phone, limit = 30) {
  const contact = stmts.getContact.get(phone);
  if (!contact) return [];
  return stmts.getHistory.all(contact.id, limit).reverse();
}

export function getRecentConversations(limit = 50) {
  return stmts.recentConversations.all(limit);
}

export function getConversation(contactId) {
  const contact = stmts.getContactById.get(contactId);
  const messages = stmts.conversationMessages.all(contactId);
  return { contact, messages };
}

export function getOpenEscalations() {
  return stmts.openEscalations.all();
}

export function resolveEscalation(id) {
  stmts.resolveEscalation.run(new Date().toISOString(), id);
}

export function getStats() {
  return stmts.stats.get();
}

export function getDailySummary(hoursBack = 24) {
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  return stmts.dailySummary.get({ since });
}

export default db;
