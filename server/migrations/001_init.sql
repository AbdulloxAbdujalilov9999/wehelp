-- WeHelp core schema: accounts, universities, the agency pipeline, document
-- checklists, payments (Click + Payme) and Telegram reminders.

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('admin','agent','student')),
  telegram_chat_id   BIGINT,
  telegram_link_code TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ieqas_status: 'excellent' | 'certified' | 'unverified' | 'not_certified' | 'restricted'
-- restricted_programs: which visa type is blocked when restricted ('degree' = D-2, 'language' = D-4, 'all').
CREATE TABLE universities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  city          TEXT,
  country       TEXT NOT NULL DEFAULT 'South Korea',
  in_catalog    BOOLEAN NOT NULL DEFAULT false,
  deadline_note TEXT,
  intake        TEXT,
  apply_url     TEXT,
  ieqas_status  TEXT NOT NULL DEFAULT 'unverified'
    CHECK (ieqas_status IN ('excellent','certified','unverified','not_certified','restricted')),
  restricted_programs TEXT CHECK (restricted_programs IN ('degree','language','all')),
  restricted_until    DATE,
  ieqas_note       TEXT,
  ieqas_checked_at DATE,
  ieqas_source     TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Checklist templates. university_id NULL = the default for that program type.
CREATE TABLE document_templates (
  id            BIGSERIAL PRIMARY KEY,
  university_id TEXT REFERENCES universities(id) ON DELETE CASCADE,
  program_type  TEXT NOT NULL CHECK (program_type IN ('degree','language','visa')),
  doc_key       TEXT NOT NULL,
  label         TEXT NOT NULL,
  sort          INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX document_templates_uniq
  ON document_templates (COALESCE(university_id, ''), program_type, doc_key);

-- One card on the agency board.
CREATE TABLE students (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  agent_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  city          TEXT,
  parent_name   TEXT,
  parent_phone  TEXT,
  stage         TEXT NOT NULL DEFAULT 'lead'
    CHECK (stage IN ('lead','documents','applied','admitted','visa','arrived')),
  closed        BOOLEAN NOT NULL DEFAULT false,
  closed_reason TEXT,
  program_type  TEXT NOT NULL DEFAULT 'degree' CHECK (program_type IN ('degree','language')),
  target_intake TEXT,
  package       TEXT,
  source        TEXT,
  notes         TEXT,
  invite_code   TEXT UNIQUE,
  parent_token  TEXT UNIQUE,
  portal_state  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX students_stage_idx ON students(stage) WHERE NOT closed;

CREATE TABLE applications (
  id            BIGSERIAL PRIMARY KEY,
  student_id    BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  university_id TEXT NOT NULL REFERENCES universities(id),
  program       TEXT,
  program_type  TEXT NOT NULL DEFAULT 'degree' CHECK (program_type IN ('degree','language')),
  status        TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','review','admitted','waitlisted','declined')),
  deadline      DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, university_id, program_type)
);

-- A student's checklist item. application_id NULL = student-level (e.g. visa).
CREATE TABLE documents (
  id             BIGSERIAL PRIMARY KEY,
  student_id     BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  application_id BIGINT REFERENCES applications(id) ON DELETE CASCADE,
  doc_key        TEXT NOT NULL,
  label          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','received','verified')),
  due_date       DATE,
  note           TEXT,
  sort           INT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_student_idx ON documents(student_id);
CREATE INDEX documents_due_idx ON documents(due_date) WHERE status = 'missing';

-- Timeline shown to the agency and (when public) to parents.
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  student_id  BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  actor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  public      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_student_idx ON events(student_id, created_at DESC);

-- Amounts are whole so'm. Payme works in tiyin (x100); converted at the edge.
CREATE TABLE invoices (
  id          BIGSERIAL PRIMARY KEY,
  student_id  BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount_uzs  BIGINT NOT NULL CHECK (amount_uzs > 0),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','refunded')),
  provider    TEXT CHECK (provider IN ('click','payme','cash','bank')),
  paid_at     TIMESTAMPTZ,
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_student_idx ON invoices(student_id);

-- Payme Merchant API transaction log. Times are Payme-style epoch millis.
CREATE TABLE payme_transactions (
  id           BIGSERIAL PRIMARY KEY,
  payme_id     TEXT NOT NULL UNIQUE,
  invoice_id   BIGINT NOT NULL REFERENCES invoices(id),
  amount_tiyin BIGINT NOT NULL,
  state        INT NOT NULL,
  payme_time   BIGINT NOT NULL,
  create_time  BIGINT NOT NULL,
  perform_time BIGINT NOT NULL DEFAULT 0,
  cancel_time  BIGINT NOT NULL DEFAULT 0,
  reason       INT
);

-- Click SHOP API transaction log.
CREATE TABLE click_transactions (
  id             BIGSERIAL PRIMARY KEY,
  click_trans_id BIGINT NOT NULL UNIQUE,
  invoice_id     BIGINT NOT NULL REFERENCES invoices(id),
  amount         NUMERIC(14,2) NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('prepared','completed','cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Parents who linked a student's progress to their Telegram.
CREATE TABLE parent_chats (
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  chat_id    BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, chat_id)
);

-- Dedupe for deadline reminders: one per item, per lead-time bucket.
CREATE TABLE reminders_sent (
  item_kind TEXT NOT NULL,
  item_id   BIGINT NOT NULL,
  bucket    INT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_kind, item_id, bucket)
);

