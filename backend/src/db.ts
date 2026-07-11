import { mkdirSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

export type AppDatabase = DatabaseSync;

export type DbName = 'orders' | 'tokenLaunches' | 'workflows' | 'verification' | 'gmail';

const DB_FILES: Record<DbName, string> = {
  orders: 'orders.db',
  tokenLaunches: 'token-launches.db',
  workflows: 'workflows.db',
  verification: 'verification.db',
  gmail: 'gmail.db'
};

const dbInstances = new Map<DbName, AppDatabase>();

function dataDir(): string {
  return process.env.DATABASE_DIR?.trim() || DATA_DIR;
}

function dbPath(name: DbName): string {
  return path.join(dataDir(), DB_FILES[name]);
}

function initOrdersSchema(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      executing_at TEXT,
      execute_time_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orders_extension ON orders(extension_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
  `);
}

function initTokenLaunchesSchema(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_launches (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      repeat_index INTEGER,
      repeat_total INTEGER,
      token_address TEXT,
      pool_address TEXT,
      deploy_block_number INTEGER,
      trades_json TEXT,
      trades_synced_at TEXT,
      deploy_tx_hash TEXT,
      add_liquidity_tx_hash TEXT,
      buy_tx_hash TEXT,
      wallet3_buy_tx_hash TEXT,
      wallet1_buy_tx_hash TEXT,
      remove_liquidity_tx_hash TEXT,
      buyer_count INTEGER NOT NULL DEFAULT 0,
      lp_removed INTEGER NOT NULL DEFAULT 0,
      wallet2_buy_executed INTEGER NOT NULL DEFAULT 0,
      wallet3_buy_executed INTEGER,
      phase TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_token_launches_created ON token_launches(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_token_launches_pool ON token_launches(pool_address);

    CREATE TABLE IF NOT EXISTS manual_lp (
      pool_address TEXT PRIMARY KEY,
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      token_decimals INTEGER,
      dex TEXT NOT NULL,
      add_tx_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_manual_lp_created ON manual_lp(created_at DESC);

    CREATE TABLE IF NOT EXISTS manual_deploys (
      id TEXT PRIMARY KEY,
      token_type TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_name TEXT,
      token_symbol TEXT,
      total_supply TEXT,
      deploy_tx_hash TEXT NOT NULL,
      deployer_address TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_manual_deploys_created ON manual_deploys(created_at DESC);
  `);
}

function initWorkflowsSchema(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      workflow_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      phase TEXT,
      input_json TEXT NOT NULL,
      wallets_json TEXT,
      stored_wallets_json TEXT,
      withdraw_order_ids_json TEXT,
      launch_job_id TEXT,
      deposit_tx_hashes_json TEXT,
      analysis_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_created ON workflows(created_at DESC);
  `);
}

function initVerificationSchema(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_requests (
      request_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      extension_id TEXT NOT NULL,
      email_code_sent_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      email_code TEXT,
      gmail_account_id TEXT,
      gmail_message_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_verification_extension ON verification_requests(extension_id);
    CREATE INDEX IF NOT EXISTS idx_verification_created ON verification_requests(created_at DESC);
  `);
}

function initGmailSchema(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gmail_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_sync_at TEXT,
      last_error TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      tokens_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gmail_accounts_connected ON gmail_accounts(connected_at DESC);

    CREATE TABLE IF NOT EXISTS gmail_used_messages (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      used_at TEXT NOT NULL,
      order_id TEXT,
      PRIMARY KEY (account_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

const SCHEMA_INIT: Record<DbName, (db: AppDatabase) => void> = {
  orders: initOrdersSchema,
  tokenLaunches: initTokenLaunchesSchema,
  workflows: initWorkflowsSchema,
  verification: initVerificationSchema,
  gmail: initGmailSchema
};

function openDb(name: DbName): AppDatabase {
  const filePath = dbPath(name);
  mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new DatabaseSync(filePath, { allowUnknownNamedParameters: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  SCHEMA_INIT[name](db);

  return db;
}

function getNamedDb(name: DbName): AppDatabase {
  const existing = dbInstances.get(name);
  if (existing) return existing;

  const db = openDb(name);
  dbInstances.set(name, db);
  return db;
}

export function getOrdersDb(): AppDatabase {
  return getNamedDb('orders');
}

export function getTokenLaunchesDb(): AppDatabase {
  return getNamedDb('tokenLaunches');
}

export function getWorkflowsDb(): AppDatabase {
  return getNamedDb('workflows');
}

export function getVerificationDb(): AppDatabase {
  return getNamedDb('verification');
}

export function getGmailDb(): AppDatabase {
  return getNamedDb('gmail');
}

export function closeAllDbs(): void {
  for (const db of dbInstances.values()) {
    db.close();
  }
  dbInstances.clear();
}
