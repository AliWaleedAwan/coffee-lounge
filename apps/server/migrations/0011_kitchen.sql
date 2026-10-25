-- 0011 Kitchen stations, ticket templates and kitchen tickets (DATABASE.md §7; Phase 3
-- step 3.5). Printers and print jobs follow in step 3.6 (stations.printer_id gets its FK
-- then). Receipt and refund templates are seeded with the receipt in step 3.6.

CREATE TABLE cl.stations (                                      -- (M) one 'Kitchen' station (D-26)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  printer_id bigint,                                           -- FK added with cl.printers (step 3.6)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);
INSERT INTO cl.stations (name) VALUES ('Kitchen');

ALTER TABLE cl.menu_items  ADD CONSTRAINT menu_items_station_fk  FOREIGN KEY (station_id) REFERENCES cl.stations;
ALTER TABLE cl.order_lines ADD CONSTRAINT order_lines_station_fk FOREIGN KEY (station_id) REFERENCES cl.stations;
CREATE INDEX menu_items_station_idx ON cl.menu_items (station_id);

CREATE TABLE cl.ticket_templates (                              -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text  NOT NULL CHECK (kind IN ('kitchen','receipt','refund')),
  name       text  NOT NULL,
  definition jsonb NOT NULL,
  is_active  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  -- AT-99: a kitchen template has no place for prices, payments or guest contact details.
  CHECK (kind <> 'kitchen' OR definition::text !~* '(price|total|amount|pay|discount|phone|email|address|customer)')
);
CREATE UNIQUE INDEX ticket_template_one_active ON cl.ticket_templates (kind) WHERE is_active;
INSERT INTO cl.ticket_templates (kind, name, definition, is_active) VALUES
  ('kitchen', 'Kitchen ticket (80 mm)',
   '{"widthMm": 80, "blocks": ["banner", "ticketNo", "where", "time", "lines", "lineNotes", "staff"]}', true);

CREATE TABLE cl.kitchen_tickets (                               -- (M) status only; content immutable
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_no            text   NOT NULL UNIQUE,                  -- 'K-1019-118'
  round_id             bigint NOT NULL REFERENCES cl.order_rounds,
  station_id           bigint NOT NULL REFERENCES cl.stations,
  kind                 text   NOT NULL CHECK (kind IN ('new','supplement','correction','void')),
  supersedes_ticket_id bigint REFERENCES cl.kitchen_tickets,
  template_id          bigint NOT NULL REFERENCES cl.ticket_templates,
  status               text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1,
  CHECK ((kind IN ('correction','void')) = (supersedes_ticket_id IS NOT NULL))
);
CREATE UNIQUE INDEX ticket_one_original ON cl.kitchen_tickets (round_id, station_id)
  WHERE kind IN ('new','supplement');
CREATE INDEX kitchen_tickets_round_idx ON cl.kitchen_tickets (round_id);
CREATE INDEX kitchen_tickets_station_idx ON cl.kitchen_tickets (station_id);
CREATE INDEX kitchen_tickets_supersedes_idx ON cl.kitchen_tickets (supersedes_ticket_id);
CREATE INDEX kitchen_tickets_template_idx ON cl.kitchen_tickets (template_id);
CREATE INDEX kitchen_tickets_open_idx ON cl.kitchen_tickets (created_at) WHERE status = 'open';

-- Only the status of a ticket changes, and only forward (DATABASE.md §12 freeze trigger).
CREATE FUNCTION cl.kitchen_ticket_status_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ticket_no <> OLD.ticket_no OR NEW.round_id <> OLD.round_id OR NEW.station_id <> OLD.station_id
     OR NEW.kind <> OLD.kind OR NEW.supersedes_ticket_id IS DISTINCT FROM OLD.supersedes_ticket_id
     OR NEW.template_id <> OLD.template_id OR NEW.created_at <> OLD.created_at
     OR (OLD.status <> 'open' AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'kitchen ticket % content cannot change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kitchen_tickets_status_only BEFORE UPDATE ON cl.kitchen_tickets
  FOR EACH ROW EXECUTE FUNCTION cl.kitchen_ticket_status_only();

CREATE TABLE cl.kitchen_ticket_lines (                          -- (A)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id     bigint NOT NULL REFERENCES cl.kitchen_tickets,
  order_line_id bigint NOT NULL REFERENCES cl.order_lines,
  qty           int    NOT NULL CHECK (qty > 0),
  display       jsonb  NOT NULL,                               -- names, size, choices, notes; never prices
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kitchen_ticket_lines_ticket_idx ON cl.kitchen_ticket_lines (ticket_id);
CREATE INDEX kitchen_ticket_lines_line_idx ON cl.kitchen_ticket_lines (order_line_id);

CREATE TRIGGER stations_touch BEFORE UPDATE ON cl.stations FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER ticket_templates_touch BEFORE UPDATE ON cl.ticket_templates FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER kitchen_tickets_touch BEFORE UPDATE ON cl.kitchen_tickets FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER kitchen_ticket_lines_append_only BEFORE UPDATE OR DELETE ON cl.kitchen_ticket_lines
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

GRANT UPDATE ON cl.stations, cl.ticket_templates, cl.kitchen_tickets TO cl_app;
