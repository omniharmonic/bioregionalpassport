-- Signed manifest history: one row per changed provision of a pod, so an
-- operator can audit or roll back to any previously signed manifest.
-- Runs with search_path scoped to `platform, public`.

CREATE TABLE IF NOT EXISTS manifest_versions (
  slug text NOT NULL REFERENCES pods(slug),
  version integer NOT NULL,
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, version)
);
