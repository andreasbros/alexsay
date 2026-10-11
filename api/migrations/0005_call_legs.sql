-- Conference legs know their part (host, guest, assistant); the assistant leg keeps its call briefing
-- until OpenAI's SIP webhook asks for it.
ALTER TABLE calls ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE calls ADD COLUMN brief TEXT;
