-- Backends become (harness + credential) instances, and the machine grows a
-- model-credential catalog.
--
-- Additive and reversible: piConfig is left in place, every existing Agent and
-- ChatSession row keeps the string it holds, and the two built-in backends keep
-- the ids they always had ('claude-tmux', 'codex-exec'). What changes is that
-- pi and dsh are no longer backends in their own right — they are harnesses you
-- pair with a credential — so this creates that pairing from what each machine
-- already had configured.
--
-- See docs/backends-and-models-design.md.

ALTER TABLE "Machine" ADD COLUMN IF NOT EXISTS "modelProviders" JSONB;

DO $migrate$
DECLARE
  m            RECORD;
  provider     TEXT;
  base_url     TEXT;
  cred_id      TEXT;
  pi_id        TEXT;
  dsh_id       TEXT;
  creds        JSONB;
  instances    JSONB;
  disabled_in  JSONB;
  disabled_out JSONB;
  d            TEXT;
  bc           JSONB;
  has_deepseek BOOLEAN;
BEGIN
  FOR m IN SELECT id, "piConfig", "backendsConfig", "modelProviders" FROM "Machine" LOOP
    -- Idempotent: a machine already carrying a catalog was migrated before.
    CONTINUE WHEN m."modelProviders" IS NOT NULL;

    bc           := COALESCE(m."backendsConfig", '{}'::jsonb);
    disabled_in  := COALESCE(bc->'disabled', '[]'::jsonb);
    creds        := '[]'::jsonb;
    instances    := '[]'::jsonb;
    pi_id        := NULL;
    dsh_id       := NULL;

    provider := NULLIF(btrim(COALESCE(m."piConfig"->>'provider', '')), '');
    base_url := NULLIF(btrim(COALESCE(m."piConfig"->>'baseUrl', '')), '');

    -- The endpoint the Pi Runtime page was configured with becomes a credential,
    -- and pi paired with it becomes a backend. A machine whose piConfig named no
    -- endpoint (never configured, or configured only for the Claude-subscription
    -- mode this release removes) gets neither: there is nothing to authenticate
    -- a pi child with, and inventing a blank one would fail at the first turn
    -- instead of here, where the Backends page can say so.
    IF provider IS NOT NULL AND base_url IS NOT NULL THEN
      cred_id := regexp_replace(lower(provider), '[^a-z0-9]+', '-', 'g');
      cred_id := btrim(cred_id, '-');
      IF cred_id = '' THEN cred_id := 'endpoint'; END IF;

      creds := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'id',           cred_id,
        'label',        provider,
        'provider',     provider,
        'api',          COALESCE(NULLIF(btrim(COALESCE(m."piConfig"->>'api', '')), ''), 'anthropic-messages'),
        'baseUrl',      base_url,
        'models',       COALESCE(m."piConfig"->'models', '[]'::jsonb),
        'defaultModel', NULLIF(btrim(COALESCE(m."piConfig"->>'defaultModel', '')), ''),
        'secretKey',    NULLIF(btrim(COALESCE(m."piConfig"->>'secretKey', '')), ''),
        'modelLimits',  m."piConfig"->'modelLimits'
      )));

      pi_id := 'pi-' || cred_id;
      instances := instances || jsonb_build_array(jsonb_build_object(
        'id', pi_id, 'harness', 'pi-rpc', 'credentialId', cred_id,
        'label', 'pi · ' || provider
      ));

      -- dsh only had two model sources. 'pi-endpoint' was this same credential.
      IF bc->>'dshSource' = 'pi-endpoint' THEN
        dsh_id := 'dsh-' || cred_id;
        instances := instances || jsonb_build_array(jsonb_build_object(
          'id', dsh_id, 'harness', 'dsh-exec', 'credentialId', cred_id,
          'label', 'dsh · ' || provider
        ));
      END IF;
    END IF;

    -- 'deepseek' was the other dsh source: its own catalog, authenticated by
    -- DEEPSEEK_API_KEY with no endpoint of ours. Represented as a credential
    -- with an empty baseUrl, which is what the gateway reads as "let dsh use its
    -- own profile". Created only where dsh was actually on, so a machine that
    -- never ran it does not acquire a backend it cannot start.
    has_deepseek := (COALESCE(bc->>'dshSource', 'deepseek') = 'deepseek')
                    AND NOT (disabled_in ? 'dsh-exec');
    IF has_deepseek THEN
      creds := creds || jsonb_build_array(jsonb_build_object(
        'id', 'deepseek', 'label', 'DeepSeek', 'provider', 'deepseek',
        'api', 'anthropic-messages', 'baseUrl', '', 'models', '[]'::jsonb,
        'secretKey', 'DEEPSEEK_API_KEY'
      ));
      dsh_id := 'dsh-deepseek';
      instances := instances || jsonb_build_array(jsonb_build_object(
        'id', dsh_id, 'harness', 'dsh-exec', 'credentialId', 'deepseek',
        'label', 'dsh · DeepSeek'
      ));
    END IF;

    -- Carry the disabled set across the rename. 'pi-rpc' / 'omp-rpc' / 'dsh-exec'
    -- are no longer backend ids; a machine that had one switched off must not
    -- come back with the replacement switched on.
    disabled_out := '[]'::jsonb;
    FOR d IN SELECT jsonb_array_elements_text(disabled_in) LOOP
      IF d IN ('claude-tmux', 'codex-exec') THEN
        disabled_out := disabled_out || to_jsonb(d);
      ELSIF d IN ('pi-rpc', 'omp-rpc') AND pi_id IS NOT NULL THEN
        disabled_out := disabled_out || to_jsonb(pi_id);
      ELSIF d = 'dsh-exec' AND dsh_id IS NOT NULL THEN
        disabled_out := disabled_out || to_jsonb(dsh_id);
      END IF;
    END LOOP;

    UPDATE "Machine"
    SET "modelProviders" = creds,
        "backendsConfig" = jsonb_strip_nulls(
          bc || jsonb_build_object('disabled', disabled_out, 'instances', instances)
        )
    WHERE id = m.id;
  END LOOP;
END
$migrate$;
