-- A free-text note per contact: who they are, when to call, anything the assistant should know.
ALTER TABLE contacts ADD COLUMN note TEXT NOT NULL DEFAULT '';
