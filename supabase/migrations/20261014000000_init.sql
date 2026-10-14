-- Carcass Trace: database schema
-- Run this once in the Supabase SQL editor (or with `supabase db push`).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Settings (one row)
-- ---------------------------------------------------------------------------
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  shop_name text not null default '',
  timezone text not null default 'Asia/Riyadh',
  label_width_mm int not null default 50,
  label_height_mm int not null default 30,
  expiry_warning_days int not null default 1
);
insert into settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Products (synced from Zid, plus shop-only fields)
-- ---------------------------------------------------------------------------
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  zid_product_id text unique,
  name text not null,
  name_ar text,
  sku text,
  barcode text,
  species text check (species in ('Sheep', 'Beef', 'Camel')),  -- null = any animal
  fixed_weight_kg numeric(10, 3),                                 -- null = weighed per tray
  shelf_life_days int not null default 3 check (shelf_life_days >= 0),
  quick boolean not null default false,                           -- show as a big button
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create index if not exists products_barcode_idx on products (barcode);
create index if not exists products_sku_idx on products (sku);

-- ---------------------------------------------------------------------------
-- Carcasses
-- ---------------------------------------------------------------------------
create table if not exists carcasses (
  id uuid primary key default gen_random_uuid(),
  no text not null unique,
  species text not null check (species in ('Sheep', 'Beef', 'Camel')),
  ear_tag text,
  farm text,
  slaughterhouse text,
  kill_no text,
  weight_kg numeric(10, 2) not null check (weight_kg > 0),
  received_at timestamptz not null default now(),
  status text not null default 'in_chiller'
    check (status in ('in_chiller', 'cutting', 'finished', 'sold_whole')),
  finished_at timestamptz,
  order_ref text,               -- set when sold whole
  notes text,
  created_by uuid default auth.uid()
);
create index if not exists carcasses_status_idx on carcasses (status);
create index if not exists carcasses_ear_tag_idx on carcasses (ear_tag);

-- ---------------------------------------------------------------------------
-- Trays (one row per printed label)
-- ---------------------------------------------------------------------------
create sequence if not exists tray_seq;

create table if not exists trays (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  product_id uuid references products (id),
  product_name text not null,
  weight_kg numeric(10, 3) not null check (weight_kg > 0),
  packed_at timestamptz not null default now(),
  use_by date not null,
  status text not null default 'in_stock' check (status in ('in_stock', 'sold', 'written_off')),
  channel text check (channel in ('online', 'counter')),
  order_ref text,
  sold_at timestamptz,
  write_off_reason text,
  created_by uuid default auth.uid()
);
create index if not exists trays_status_idx on trays (status);
create index if not exists trays_order_ref_idx on trays (order_ref);

create table if not exists tray_carcasses (
  tray_id uuid not null references trays (id) on delete cascade,
  carcass_id uuid not null references carcasses (id),
  primary key (tray_id, carcass_id)
);
create index if not exists tray_carcasses_carcass_idx on tray_carcasses (carcass_id);

-- ---------------------------------------------------------------------------
-- Orders (online Zid orders and counter sales)
-- ---------------------------------------------------------------------------
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,          -- Zid order number, or counter receipt number
  channel text not null check (channel in ('online', 'counter')),
  customer_name text,
  trace_summary text,
  zid_comment_posted boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

-- ---------------------------------------------------------------------------
-- Zid connection tokens: no policies, so only the server (service role) can read them
-- ---------------------------------------------------------------------------
create table if not exists zid_connection (
  id int primary key default 1 check (id = 1),
  authorization_token text,
  access_token text,
  refresh_token text,
  store_id text,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Access: any signed-in staff member can use the system
-- ---------------------------------------------------------------------------
alter table settings enable row level security;
alter table products enable row level security;
alter table carcasses enable row level security;
alter table trays enable row level security;
alter table tray_carcasses enable row level security;
alter table orders enable row level security;
alter table zid_connection enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings', 'products', 'carcasses', 'trays', 'tray_carcasses', 'orders'] loop
    execute format('drop policy if exists staff_all on %I', t);
    execute format('create policy staff_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function shop_today() returns date
language sql stable as $$
  select (now() at time zone (select timezone from settings where id = 1))::date
$$;

-- Register a received carcass and give it the next number for today: S1014-01, B1014-01, C1014-01
create or replace function register_carcass(
  p_species text, p_weight_kg numeric, p_ear_tag text default null, p_farm text default null,
  p_slaughterhouse text default null, p_kill_no text default null, p_notes text default null
) returns carcasses
language plpgsql as $$
declare
  v_prefix text;
  v_n int;
  v_row carcasses;
begin
  v_prefix := case p_species when 'Sheep' then 'S' when 'Beef' then 'B' when 'Camel' then 'C' end
              || to_char(shop_today(), 'MMDD');
  if v_prefix is null then raise exception 'Unknown animal type %', p_species; end if;
  perform pg_advisory_xact_lock(hashtext('carcass_no_' || v_prefix));
  select coalesce(max(split_part(no, '-', 2)::int), 0) + 1 into v_n
    from carcasses where no like v_prefix || '-%' and received_at > now() - interval '300 days';
  insert into carcasses (no, species, weight_kg, ear_tag, farm, slaughterhouse, kill_no, notes)
  values (v_prefix || '-' || lpad(v_n::text, 2, '0'), p_species, p_weight_kg,
          nullif(trim(p_ear_tag), ''), nullif(trim(p_farm), ''), nullif(trim(p_slaughterhouse), ''),
          nullif(trim(p_kill_no), ''), nullif(trim(p_notes), ''))
  returning * into v_row;
  return v_row;
end $$;

-- Create p_count trays of one product from one or more carcasses; returns the new trays to print
create or replace function create_trays(
  p_product_id uuid, p_carcass_ids uuid[], p_count int, p_weight_kg numeric default null
) returns setof trays
language plpgsql as $$
declare
  v_product products;
  v_weight numeric;
  v_tray trays;
  v_bad text;
  i int;
begin
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'Number of trays must be between 1 and 200';
  end if;
  if p_carcass_ids is null or array_length(p_carcass_ids, 1) is null then
    raise exception 'Scan the carcass first';
  end if;
  select * into v_product from products where id = p_product_id;
  if not found then raise exception 'Product not found'; end if;
  v_weight := coalesce(p_weight_kg, v_product.fixed_weight_kg);
  if v_weight is null or v_weight <= 0 then raise exception 'Enter the tray weight'; end if;

  select string_agg(no, ', ') into v_bad from carcasses
    where id = any (p_carcass_ids) and status = 'sold_whole';
  if v_bad is not null then raise exception 'Carcass % was sold whole', v_bad; end if;
  if (select count(*) from carcasses where id = any (p_carcass_ids)) <> array_length(p_carcass_ids, 1) then
    raise exception 'Carcass not found';
  end if;

  update carcasses set status = 'cutting' where id = any (p_carcass_ids) and status = 'in_chiller';

  for i in 1..p_count loop
    insert into trays (code, product_id, product_name, weight_kg, use_by)
    values ('T' || lpad(nextval('tray_seq')::text, 7, '0'), v_product.id, v_product.name, v_weight,
            shop_today() + v_product.shelf_life_days)
    returning * into v_tray;
    insert into tray_carcasses (tray_id, carcass_id) select v_tray.id, unnest(p_carcass_ids);
    return next v_tray;
  end loop;
end $$;

-- Per-product summary of which carcasses a set of trays came from:
--   "Leg: S1014-01, S1014-02 | Mince: S1014-01, S1014-03"
create or replace function trace_summary_for_codes(p_codes text[])
returns text language sql stable as $$
  with items as (
    select t.product_name, c.no
    from trays t
    join tray_carcasses tc on tc.tray_id = t.id
    join carcasses c on c.id = tc.carcass_id
    where t.code = any (p_codes)
    union
    select 'Whole ' || lower(c.species), c.no from carcasses c where c.no = any (p_codes)
  ), per_product as (
    select product_name, string_agg(distinct no, ', ') as nos from items group by product_name
  )
  select string_agg(product_name || ': ' || nos, ' | ' order by product_name) from per_product
$$;

-- Mark trays (and whole carcasses) as gone. Fails without changing anything if any item is not in stock.
create or replace function sell_items(
  p_codes text[], p_channel text, p_order_ref text, p_customer_name text default null
) returns orders
language plpgsql as $$
declare
  v_codes text[];
  v_bad text;
  v_ref text;
  v_order orders;
  v_now timestamptz := now();
begin
  select array_agg(distinct trim(c)) into v_codes from unnest(p_codes) c where trim(c) <> '';
  if v_codes is null then raise exception 'Scan at least one tray'; end if;
  if p_channel not in ('online', 'counter') then raise exception 'Unknown channel %', p_channel; end if;
  v_ref := nullif(trim(p_order_ref), '');
  if v_ref is null then
    if p_channel = 'online' then raise exception 'Enter the Zid order number'; end if;
    v_ref := 'C' || to_char(v_now at time zone (select timezone from settings where id = 1), 'YYMMDD-HH24MISS');
  end if;

  -- lock the rows we are about to change
  perform 1 from trays where code = any (v_codes) for update;
  perform 1 from carcasses where no = any (v_codes) for update;

  select string_agg(x, ', ') into v_bad from (
    select c as x from unnest(v_codes) c
    where not exists (select 1 from trays t where t.code = c)
      and not exists (select 1 from carcasses k where k.no = c)
    union all
    select t.code || ' (' || case t.status when 'sold' then 'already left on ' || coalesce(t.order_ref, '?')
                                           else 'written off' end || ')'
    from trays t where t.code = any (v_codes) and t.status <> 'in_stock'
    union all
    select k.no || ' (already sold whole)' from carcasses k where k.no = any (v_codes) and k.status = 'sold_whole'
  ) s;
  if v_bad is not null then raise exception 'Not in stock: %', v_bad; end if;

  update trays set status = 'sold', channel = p_channel, order_ref = v_ref, sold_at = v_now
    where code = any (v_codes);
  update carcasses set status = 'sold_whole', order_ref = v_ref, finished_at = v_now
    where no = any (v_codes);

  insert into orders (ref, channel, customer_name, trace_summary)
  values (v_ref, p_channel, nullif(trim(p_customer_name), ''), trace_summary_for_codes(v_codes))
  on conflict (ref) do update
    set trace_summary = (
          select trace_summary_for_codes(array_agg(t.code) || array(select no from carcasses where order_ref = v_ref))
          from trays t where t.order_ref = v_ref),
        customer_name = coalesce(excluded.customer_name, orders.customer_name)
  returning * into v_order;
  return v_order;
end $$;

-- Take trays out of stock without a sale (waste, expired, missing at stock check)
create or replace function write_off_trays(p_codes text[], p_reason text)
returns int language plpgsql as $$
declare v_n int;
begin
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason'; end if;
  update trays set status = 'written_off', write_off_reason = trim(p_reason), sold_at = now()
    where code = any (p_codes) and status = 'in_stock';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Delete a misprinted tray label (only while still in stock)
create or replace function void_tray(p_code text)
returns void language plpgsql as $$
begin
  delete from trays where code = p_code and status = 'in_stock';
  if not found then raise exception 'Tray % is not in stock, so it cannot be removed', p_code; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
create or replace view stock_by_product with (security_invoker = true) as
  select t.product_id, t.product_name,
         count(*) as trays,
         sum(t.weight_kg) as kg,
         min(t.use_by) as oldest_use_by,
         count(*) filter (where t.use_by < shop_today()) as expired,
         count(*) filter (where t.use_by between shop_today()
                          and shop_today() + (select expiry_warning_days from settings where id = 1)) as expiring_soon
  from trays t
  where t.status = 'in_stock'
  group by t.product_id, t.product_name;

-- Batch trays (mince from several carcasses) count their weight split evenly across those carcasses
create or replace view carcass_yield with (security_invoker = true) as
  with shares as (
    select tc.carcass_id, t.status, t.weight_kg / count(*) over (partition by t.id) as kg_share
    from trays t join tray_carcasses tc on tc.tray_id = t.id
  )
  select c.id, c.no, c.species, c.ear_tag, c.farm, c.slaughterhouse, c.status, c.received_at, c.weight_kg,
         coalesce(sum(s.kg_share), 0)::numeric(10, 2) as packed_kg,
         count(s.*) as trays,
         count(s.*) filter (where s.status = 'in_stock') as trays_in_stock,
         count(s.*) filter (where s.status = 'sold') as trays_sold,
         case when c.weight_kg > 0 then round(coalesce(sum(s.kg_share), 0) / c.weight_kg * 100, 1) end as yield_pct
  from carcasses c left join shares s on s.carcass_id = c.id
  group by c.id;

grant usage on sequence tray_seq to authenticated;
grant select on stock_by_product, carcass_yield to authenticated;
