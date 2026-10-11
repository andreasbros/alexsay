-- Guests are dialled once the host is on the line and the assistant once a guest has answered;
-- answered_by keeps Twilio's answering machine detection, and only one assistant leg may exist per conference.
ALTER TABLE calls ADD COLUMN answered_by TEXT;
CREATE UNIQUE INDEX calls_one_assistant ON calls (conference) WHERE role = 'assistant';
