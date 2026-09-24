-- Healthy: structured exposure rules.
--
-- Apply with `npm run migrate:local` (Miniflare) or `npm run migrate:remote`
-- (production) BEFORE deploying code that depends on it.
--
-- A `field` rule used to be one string, `ResourceType.path` (or
-- `allow:ResourceType.field`), scoped to a resource type and nothing else, one
-- path per row. It now has columns: an effect, an optional tool, resource type
-- and health system scope, and a JSON array of one or more paths. Every rule
-- kind gains `enabled`, so the owner can switch a rule off without losing it.
--
-- `target` stays NOT NULL: for a `field` rule the Worker writes a signature of
-- the columns into it (so the same rule is not stored twice); the unique index
-- on (rule_type, target) is rebuilt partial, over the other kinds only, because
-- a converted legacy row keeps its old string and could otherwise collide with
-- a signature. Field-rule dedupe is the Worker's job.

ALTER TABLE mcp_policy ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
ALTER TABLE mcp_policy ADD COLUMN effect TEXT NOT NULL DEFAULT 'hide' CHECK (effect IN ('hide', 'allow'));
ALTER TABLE mcp_policy ADD COLUMN scope_tool TEXT;
ALTER TABLE mcp_policy ADD COLUMN scope_resource TEXT;
ALTER TABLE mcp_policy ADD COLUMN scope_health_system TEXT;
ALTER TABLE mcp_policy ADD COLUMN paths_json TEXT;

DROP INDEX mcp_policy_rule;
CREATE UNIQUE INDEX mcp_policy_rule ON mcp_policy (rule_type, target) WHERE rule_type != 'field';

-- Legacy `allow:` rows: the effect moves to its column. `target` keeps the
-- whole old string; the conversion below reads past the prefix.
UPDATE mcp_policy
   SET effect = 'allow'
 WHERE rule_type = 'field' AND substr(trim(target), 1, 6) = 'allow:';

-- Every legacy field row that has a `Type.path` shape: the part before the
-- first dot is the resource type (`*` meaning every type), the rest the one
-- path. A row with no dot, or nothing on one side of it, is left with
-- `paths_json` NULL: the Worker's legacy parser still reads it and reports it
-- as unparsed, which is what it was before.
UPDATE mcp_policy
   SET scope_resource = NULLIF(trim(substr(body, 1, instr(body, '.') - 1)), '*'),
       paths_json = json_array(trim(substr(body, instr(body, '.') + 1)))
  FROM (SELECT id AS row_id,
               CASE WHEN substr(trim(target), 1, 6) = 'allow:'
                    THEN trim(substr(trim(target), 7))
                    ELSE trim(target) END AS body
          FROM mcp_policy
         WHERE rule_type = 'field')
 WHERE mcp_policy.id = row_id
   AND instr(body, '.') > 1
   AND length(trim(substr(body, instr(body, '.') + 1))) > 0;
