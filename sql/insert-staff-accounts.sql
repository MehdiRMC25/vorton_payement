CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'customer';

INSERT INTO customers (first_name, last_name, email, phone, password_hash, password_salt, membership_number, role)
VALUES ('Staff', 'employee', 'gulnara.habisheva@caspiantextile.com', 'staff-emp1', crypt('employee123', gen_salt('bf')), NULL, 'STAFF-EMP1', 'employee');

INSERT INTO customers (first_name, last_name, email, phone, password_hash, password_salt, membership_number, role)
VALUES ('Staff', 'manager', 'mehdi.taghiyev@caspiantextile.com', 'staff-mgr1', crypt('manager123', gen_salt('bf')), NULL, 'STAFF-MGR1', 'manager');
