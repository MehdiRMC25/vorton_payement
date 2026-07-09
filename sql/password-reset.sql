CREATE TABLE IF NOT EXISTS password_reset_pending (
                                                      id SERIAL PRIMARY KEY,
                                                      customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(customer_id)
    );

CREATE TABLE IF NOT EXISTS password_reset_request_log (
                                                          id BIGSERIAL PRIMARY KEY,
                                                          customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

CREATE INDEX IF NOT EXISTS idx_password_reset_pending_email
    ON password_reset_pending (LOWER(TRIM(email)));