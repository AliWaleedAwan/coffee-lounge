-- 0037 The old POS's records (owner's request, Nov 2026): its customers, for search and to fill
-- in a delivery from a known mobile number, and its sales as history for reports. The history
-- is kept as it was and apart from Coffee Lounge's own bills, cash and stock; the application
-- may add to it (the import) but never change or remove it.

CREATE TABLE cl.customers (                                     -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mobile      text   NOT NULL UNIQUE CHECK (mobile ~ '^[0-9]{7,15}$'),   -- digits only, 03xx... form
  name        text   CHECK (char_length(name) <= 60),
  location    text   CHECK (char_length(location) <= 300),
  last_seen   date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_name_idx ON cl.customers (lower(name));
GRANT UPDATE ON cl.customers TO cl_app;

CREATE TABLE cl.old_pos_bills (                                 -- (A) the old POS's receipts
  old_id          integer PRIMARY KEY,                          -- the old database's own id
  bill_no         integer NOT NULL,                             -- not unique there
  sold_at         timestamptz NOT NULL,
  total           integer NOT NULL,
  discount        integer NOT NULL,
  payable         integer NOT NULL,
  paid            integer NOT NULL,
  balance         integer NOT NULL,
  status          text    NOT NULL CHECK (char_length(status) <= 20),
  customer_mobile text    CHECK (customer_mobile ~ '^[0-9]{7,15}$'),
  cashier         text    CHECK (char_length(cashier) <= 60)
);
CREATE INDEX old_pos_bills_sold_at_idx ON cl.old_pos_bills (sold_at);
CREATE INDEX old_pos_bills_mobile_idx ON cl.old_pos_bills (customer_mobile);

CREATE TABLE cl.old_pos_bill_lines (                            -- (A) the old POS's bill lines
  old_id    integer PRIMARY KEY,
  bill_no   integer NOT NULL,
  sold_at   timestamptz NOT NULL,
  item      text    NOT NULL CHECK (char_length(item) <= 120),
  category  text    CHECK (char_length(category) <= 60),
  barcode   text    CHECK (char_length(barcode) <= 40),
  qty       integer NOT NULL,
  price     integer NOT NULL,
  amount    integer NOT NULL,
  status    text    NOT NULL CHECK (char_length(status) <= 20)
);
CREATE INDEX old_pos_bill_lines_sold_at_idx ON cl.old_pos_bill_lines (sold_at);
