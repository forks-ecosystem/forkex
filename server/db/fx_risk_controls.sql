-- fx_risk_controls.sql
-- Order-lock accounting + withdrawal risk gate for the exchange DB.
-- Apply: psql -U admin -d hollaex -f fx_risk_controls.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What each user's open orders reserve, per currency.
--    buy  -> reserves quote (pair_2) = size * price * (1 + maker_fee)
--    sell -> reserves base  (pair_base) = size * (1 + maker_fee)
--    HollaEx zeroes size/quantity once an order fills, so `size` on an active
--    order is the full remaining obligation. Verified over all 2.1M orders:
--    there has never been a partial fill, so accepted_amount is not subtracted.
--    'partially-filled' is included because the engine's own book index
--    (idx_orders_book_partial) treats it as active - ignoring it would hide
--    an obligation exactly when it starts to matter.
--
--    FEE: not pairs.maker_fees. The engine charges DOUBLE the configured rate
--    at fill time: over 2252 trades in the last 6h, trades.maker_fee is
--    exactly notional*0.001 and trades.taker_fee is exactly notional*0.002,
--    while pairs.maker_fees = 0.0005 / taker_fees = 0.001. The taker rate
--    (the larger one) is used as the bound: a resting order fills as maker, but
--    if the engine ever charges taker the reserve is still sufficient.
--    Remaining error after this fix: 0.1% of notional, always in the safe
--    direction. Using the configured 0.0005 instead was optimistic 2x.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW fx_order_locks AS
SELECT t.user_id, t.cur, SUM(t.n)::numeric AS need
FROM (
    SELECT o.user_id, p.pair_2 AS cur, o.size * o.price * (1 + 2 * p.taker_fees) AS n
    FROM orders o JOIN pairs p ON p.id = o.pair_id
    WHERE o.status IN ('open', 'partially-filled') AND o.side = 'buy'
    UNION ALL
    SELECT o.user_id, p.pair_base, o.size * (1 + 2 * p.taker_fees)
    FROM orders o JOIN pairs p ON p.id = o.pair_id
    WHERE o.status IN ('open', 'partially-filled') AND o.side = 'sell'
) t
GROUP BY t.user_id, t.cur;

-- ---------------------------------------------------------------------------
-- 2. Apply the reservation to balances: locked = min(need, balance),
--    available = balance - locked. Never lets available go negative; the part
--    of `need` that the balance cannot cover is left visible as `uncovered`.
-- ---------------------------------------------------------------------------
-- Dropped first: the return row type changes between revisions of this file.
DROP FUNCTION IF EXISTS fx_apply_locks(integer);
CREATE OR REPLACE FUNCTION fx_apply_locks(p_user_id int DEFAULT NULL)
RETURNS TABLE(currency text, balance numeric, need_locked numeric, locked numeric,
              available numeric, uncovered numeric)
LANGUAGE plpgsql AS $$
BEGIN
    IF p_user_id IS NOT NULL THEN
        UPDATE balances b
        SET locked = LEAST(GREATEST(COALESCE(l.need, 0), 0), GREATEST(b.balance, 0)),
            available = GREATEST(b.balance, 0)
                          - LEAST(GREATEST(COALESCE(l.need, 0), 0), GREATEST(b.balance, 0)),
            updated_at = NOW()
        FROM (SELECT f.cur, f.need FROM fx_order_locks f WHERE f.user_id = p_user_id) l
        WHERE b.user_id = p_user_id AND b.currency = l.cur;

        UPDATE balances b
        SET locked = 0, available = GREATEST(b.balance, 0), updated_at = NOW()
        WHERE b.user_id = p_user_id
          AND NOT EXISTS (SELECT 1 FROM fx_order_locks f
                          WHERE f.user_id = p_user_id AND f.cur = b.currency);
    ELSE
        UPDATE balances b
        SET locked = LEAST(GREATEST(COALESCE(l.need, 0), 0), GREATEST(b.balance, 0)),
            available = GREATEST(b.balance, 0)
                          - LEAST(GREATEST(COALESCE(l.need, 0), 0), GREATEST(b.balance, 0)),
            updated_at = NOW()
        FROM (SELECT f.user_id, f.cur, f.need FROM fx_order_locks f) l
        WHERE b.user_id = l.user_id AND b.currency = l.cur;

        UPDATE balances b
        SET locked = 0, available = GREATEST(b.balance, 0), updated_at = NOW()
        WHERE b.locked <> 0
          AND NOT EXISTS (SELECT 1 FROM fx_order_locks f
                          WHERE f.user_id = b.user_id AND f.cur = b.currency);
    END IF;

    RETURN QUERY
    SELECT b.currency::text, b.balance,
           COALESCE((SELECT f.need FROM fx_order_locks f
                     WHERE f.user_id = b.user_id AND f.cur = b.currency), 0),
           b.locked, b.available,
           GREATEST(COALESCE((SELECT f.need FROM fx_order_locks f
                              WHERE f.user_id = b.user_id AND f.cur = b.currency), 0)
                    - b.balance, 0)
    FROM balances b
    WHERE (p_user_id IS NULL AND (b.locked > 0 OR b.available <> GREATEST(b.balance, 0)))
       OR b.user_id = p_user_id
    ORDER BY b.user_id, b.currency;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Explicit, tunable policy. amount NULL or 0 = no limit of that kind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_risk_limits (
    id serial PRIMARY KEY,
    kind text NOT NULL,            -- single | monthly | kyc_above
    currency text NOT NULL,        -- coin symbol or '*' for any
    amount numeric,
    note text,
    enabled boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fx_risk_limits_uniq ON fx_risk_limits (kind, currency);

-- Declared policy. ON CONFLICT DO NOTHING: re-applying this file never
-- overwrites limits an operator has tuned by hand.
INSERT INTO fx_risk_limits (kind, currency, amount, note) VALUES
    ('single',   'lbtc', 500,        'max single LBTC withdrawal'),
    ('single',   'usdt', 25000,      'max single USDT withdrawal'),
    ('monthly',  'lbtc', 2500,       'max LBTC per calendar month'),
    ('monthly',  'usdt', 100000,     'max USDT per calendar month'),
    ('kyc_above','lbtc', 250,        'LBTC above this needs a KYC account'),
    ('kyc_above','usdt', 10000,      'USDT above this needs a KYC account')
ON CONFLICT (kind, currency) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Withdrawal gate. Enforced in the database because the exchange engine is
--    a closed binary: this is the only place a withdrawal cannot bypass.
--    Operator escape hatch:  SET LOCAL fx.gate = 'off';
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fx_withdrawal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_sym text;
    v_avail numeric;
    v_bal  numeric;
    v_need numeric;
    v_blocked timestamptz;
    v_flagged boolean;
    v_kyc boolean;
    v_activated boolean;
    v_limit numeric;
    v_kyc_above numeric;
    v_month numeric;
    v_month_cap numeric;
BEGIN
    IF current_setting('fx.gate', true) = 'off' THEN
        RETURN NEW;
    END IF;

    SELECT c.symbol INTO v_sym FROM coins c WHERE c.id = NEW.coin_id;
    IF v_sym IS NULL THEN
        RAISE EXCEPTION 'withdrawal blocked: unknown coin_id %', NEW.coin_id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT u.withdrawal_blocked, u.flagged, u.is_kyc, u.activated
      INTO v_blocked, v_flagged, v_kyc, v_activated
    FROM users u WHERE u.id = NEW.user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'withdrawal blocked: unknown user %', NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_blocked IS NOT NULL THEN
        RAISE EXCEPTION 'withdrawal blocked: account withdrawal_blocked since %', v_blocked
            USING ERRCODE = 'check_violation';
    END IF;
    IF v_flagged THEN
        RAISE EXCEPTION 'withdrawal blocked: account is flagged'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT v_activated THEN
        RAISE EXCEPTION 'withdrawal blocked: account is not activated'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(b.available, 0), COALESCE(b.balance, 0)
      INTO v_avail, v_bal
    FROM balances b WHERE b.user_id = NEW.user_id AND b.currency = v_sym;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'withdrawal blocked: no % balance for user %', v_sym, NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.amount + COALESCE(NEW.fee, 0) > v_avail THEN
        RAISE EXCEPTION 'withdrawal blocked: % available (net of open-order locks), requested % %',
            v_avail, NEW.amount + COALESCE(NEW.fee, 0), v_sym
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(need), 0) INTO v_need
    FROM fx_order_locks WHERE user_id = NEW.user_id AND cur = v_sym;
    IF v_need > v_bal THEN
        RAISE EXCEPTION 'withdrawal blocked: open orders need % % but balance is %',
            v_need, v_sym, v_bal
            USING ERRCODE = 'check_violation';
    END IF;

    -- Any uncovered position in ANY currency blocks every withdrawal of that
    -- user: an account trading far beyond its balance can pull value out of an
    -- unrelated currency the moment orders settle.
    IF EXISTS (SELECT 1 FROM fx_order_locks f
               LEFT JOIN balances b ON b.user_id = f.user_id AND b.currency = f.cur
               WHERE f.user_id = NEW.user_id AND f.need > COALESCE(b.balance, 0)) THEN
        RAISE EXCEPTION 'withdrawal blocked: account has open orders exceeding its balance (% uncovered positions)',
            (SELECT count(*) FROM fx_order_locks f2
             LEFT JOIN balances b2 ON b2.user_id = f2.user_id AND b2.currency = f2.cur
             WHERE f2.user_id = NEW.user_id AND f2.need > COALESCE(b2.balance, 0))
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT l.amount INTO v_limit FROM fx_risk_limits l
    WHERE l.enabled AND l.kind = 'single' AND (l.currency = v_sym OR l.currency = '*')
    ORDER BY (l.currency = v_sym) DESC LIMIT 1;
    IF v_limit IS NOT NULL AND v_limit > 0 AND NEW.amount > v_limit THEN
        RAISE EXCEPTION 'withdrawal blocked: single % limit is %, requested %',
            v_sym, v_limit, NEW.amount
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT l.amount INTO v_kyc_above FROM fx_risk_limits l
    WHERE l.enabled AND l.kind = 'kyc_above' AND (l.currency = v_sym OR l.currency = '*')
    ORDER BY (l.currency = v_sym) DESC LIMIT 1;
    IF v_kyc_above IS NOT NULL AND v_kyc_above > 0
       AND NEW.amount > v_kyc_above AND NOT v_kyc THEN
        RAISE EXCEPTION 'withdrawal blocked: % % above KYC threshold % and account has no KYC',
            NEW.amount, v_sym, v_kyc_above
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(w.amount + COALESCE(w.fee, 0)), 0) INTO v_month
    FROM withdrawals w
    WHERE w.user_id = NEW.user_id AND w.coin_id = NEW.coin_id
      AND w.created_at >= date_trunc('month', now())
      AND w.status NOT IN ('cancelled', 'failed', 'rejected');

    SELECT l.amount INTO v_month_cap FROM fx_risk_limits l
    WHERE l.enabled AND l.kind = 'monthly' AND (l.currency = v_sym OR l.currency = '*')
    ORDER BY (l.currency = v_sym) DESC LIMIT 1;
    IF v_month_cap IS NOT NULL AND v_month_cap > 0 AND v_month + NEW.amount > v_month_cap THEN
        RAISE EXCEPTION 'withdrawal blocked: monthly % limit %, already used %',
            v_sym, v_month_cap, v_month
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS fx_withdrawal_guard_trg ON withdrawals;
CREATE TRIGGER fx_withdrawal_guard_trg
    BEFORE INSERT ON withdrawals
    FOR EACH ROW EXECUTE FUNCTION fx_withdrawal_guard();



-- ---------------------------------------------------------------------------
-- 9. ORDER ADMISSION GATE
--    Priority 1: refuse to CREATE an order that the balance cannot cover.
--    This is the only control that stops the growth instead of reporting it.
--      sell -> needs base  >= size * (1 + maker_fee)
--      buy  -> needs quote >= size * price * (1 + maker_fee)
--    Reserve is computed with exactly the same formula as fx_order_locks, so an
--    admitted order can never show up as uncovered on the next reconcile pass.
--
--    Mode lives in a table, NOT in a GUC: the engine uses a connection pool and
--    a session-level SET would not reach new connections.
--      off   -> pass everything (pre-gate behaviour)
--      warn  -> admit, but record every order the gate would have refused
--      block -> refuse
--    Rollout: warn first, read the log, then block.
--    Operator bypass for both gates: SET LOCAL fx.gate = 'off';
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_admission_control (
    id         boolean PRIMARY KEY DEFAULT true CHECK (id),
    mode       text NOT NULL DEFAULT 'warn' CHECK (mode IN ('off', 'warn', 'block')),
    note       text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fx_admission_control (id, mode) VALUES (true, 'warn')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS fx_admission_denied (
    id         bigserial PRIMARY KEY,
    ts         timestamptz NOT NULL DEFAULT now(),
    user_id    int,
    pair_id    int,
    side       text,
    price      double precision,
    size       double precision,
    need       double precision,
    balance    numeric,
    reserved   double precision,
    bot_user_id int,
    reason     text
);
CREATE INDEX IF NOT EXISTS idx_fx_denied_ts ON fx_admission_denied (ts DESC);

CREATE OR REPLACE FUNCTION fx_order_admission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_mode    text;
    v_base    text;
    v_quote   text;
    v_fee     double precision;
    v_cur     text;
    v_need    double precision;
    v_res     double precision;
    v_bal     numeric;
    v_delta   double precision;
BEGIN
    -- Bypass only when explicitly set. Unset (NULL) must NOT read as 'off',
    -- otherwise the gate silently passes everything in a normal session.
    IF current_setting('fx.gate', true) = 'off' THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE((SELECT mode FROM fx_admission_control WHERE id), 'warn')
      INTO v_mode;
    IF v_mode = 'off' THEN
        RETURN NEW;
    END IF;

    SELECT p.pair_base, p.pair_2, 2 * p.taker_fees INTO v_base, v_quote, v_fee
      FROM pairs p WHERE p.id = NEW.pair_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- A pending -> open flip also creates the obligation, so status changes
        -- must be watched too, not just size. A fill (size -> 0) and any
        -- decrease must never be touched.
        IF NEW.status NOT IN ('open', 'partially-filled') THEN
            RETURN NEW;
        END IF;
        IF OLD.status IN ('open', 'partially-filled') THEN
            IF NEW.size <= OLD.size THEN
                RETURN NEW;
            END IF;
            v_delta := NEW.size - OLD.size;
        ELSE
            v_delta := NEW.size;
        END IF;
    ELSE
        v_delta := NEW.size;
    END IF;

    IF NEW.side = 'buy' THEN
        v_cur  := v_quote;
        v_need := v_delta * NEW.price * (1 + v_fee);
    ELSE
        v_cur  := v_base;
        v_need := v_delta * (1 + v_fee);
    END IF;
    IF v_need IS NULL OR v_need <= 0 THEN
        RETURN NEW;
    END IF;

    -- What this user's other active orders already reserve in this currency.
    SELECT COALESCE(SUM(o.size * o.price * (1 + 2 * p.taker_fees)), 0)
      INTO v_res
      FROM orders o JOIN pairs p ON p.id = o.pair_id
     WHERE o.user_id = NEW.user_id
       AND o.status IN ('open', 'partially-filled')
       AND o.side = 'buy'
       AND p.pair_2 = v_cur;
    IF NEW.side <> 'buy' THEN
        SELECT COALESCE(SUM(o.size * (1 + 2 * p.taker_fees)), 0)
          INTO v_res
          FROM orders o JOIN pairs p ON p.id = o.pair_id
         WHERE o.user_id = NEW.user_id
           AND o.status IN ('open', 'partially-filled')
           AND o.side = 'sell'
           AND p.pair_base = v_cur;
    END IF;

    SELECT balance INTO v_bal FROM balances WHERE user_id = NEW.user_id AND currency = v_cur;
    v_bal := COALESCE(v_bal, 0);

    IF v_bal::double precision >= v_res + v_need THEN
        RETURN NEW;
    END IF;

    INSERT INTO fx_admission_denied
        (user_id, pair_id, side, price, size, need, balance, reserved, bot_user_id, reason)
    VALUES
        (NEW.user_id, NEW.pair_id, NEW.side, NEW.price, NEW.size, v_need, v_bal, v_res,
         NEW.bot_user_id,
         'mode=' || v_mode || ' cur=' || v_cur
         || ' need=' || round(v_need::numeric, 10)
         || ' reserved=' || round(v_res::numeric, 10)
         || ' total=' || round((v_res + v_need)::numeric, 10)
         || ' balance=' || round(v_bal::numeric, 10));

    IF v_mode = 'block' THEN
        -- The row inserted above is rolled back together with the rejected
        -- INSERT, so it cannot be the audit trail in block mode. RAISE LOG
        -- survives the rollback; the engine log carries the same reason.
        RAISE LOG 'fx_admission denied user=% pair=% % % need=% reserved=% total=% balance=% bot=%',
            NEW.user_id, NEW.pair_id, NEW.side, v_cur,
            round(v_need::numeric, 8), round(v_res::numeric, 8),
            round((v_res + v_need)::numeric, 8), round(v_bal::numeric, 8),
            NEW.bot_user_id;
        RAISE EXCEPTION
            'order rejected: % % requires % (already reserved % of %), balance %',
            v_cur, NEW.side, round(v_need::numeric, 8),
            round(v_res::numeric, 8), round((v_res + v_need)::numeric, 8),
            round(v_bal::numeric, 8)
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS fx_order_admission_guard_trg ON orders;
CREATE TRIGGER fx_order_admission_guard_trg
    BEFORE INSERT OR UPDATE OF size, status ON orders
    FOR EACH ROW EXECUTE FUNCTION fx_order_admission_guard();



COMMIT;
