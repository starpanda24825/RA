-- Regnum Aeternum — D1 schema addition: structured legal content
-- (preamble, paragraphs, point lists, sub-headings)
-- Apply with:
--   wrangler d1 execute regnum-aeternum-db --local  --file=./migrations/0003_legal_content_model.sql
--   wrangler d1 execute regnum-aeternum-db --remote --file=./migrations/0003_legal_content_model.sql
--
-- No new columns or tables: legal_acts.data is already a free-form JSON
-- blob (see 0002_legal.sql), so the richer content model slots into the
-- exact same column:
--   * Act-level `preamble`            — optional array of ContentNodes
--                                        shown before Chapter I.
--   * Per-article-version `content`  — an array of ContentNodes
--                                        ({type: paragraph|list|heading})
--                                        in place of the old flat `text`
--                                        string.
-- Older rows that only have `text` keep working untouched — both
-- worker/routes/legal.js and legal-app.js fall back to treating `text`
-- as a single paragraph when `content` is absent. See the header comment
-- in regnum-aeternum/legal/assets/legal-data.js for the full node shapes.
--
-- This migration just upgrades the three seed rows that
-- regnum-aeternum/legal/assets/legal-data.js now demonstrates the new
-- shape on, so the live (D1-backed) site and the offline static fallback
-- stay in agreement. Nothing here is *required* for the new shape to
-- work going forward — new/edited acts saved from the admin panel's
-- visual builder will already be in this shape.

-- Constitution: add a three-recital preamble.
UPDATE legal_acts
SET data = json_set(
      data,
      '$.preamble',
      json('[{"type":"paragraph","text":"WHEREAS the people and lawful authorities of Regnum Aeternum have resolved to constitute an enduring civic order, grounded in law rather than the will of any one office;"},{"type":"paragraph","text":"WHEREAS the Crown and its lawful organs hold authority only insofar as it is granted by this Constitution and the Acts made under it;"},{"type":"paragraph","text":"NOW THEREFORE this Constitution is ordained as the founding charter of the realm, binding the Crown, its officers, and all citizens alike."}]')
    ),
    updated_at = '2026-06-23T00:00:00.000Z'
WHERE slug = 'constitution';

-- Judicial Power Act, Art. 2 (Composition and Chambers) — chapters[0] is
-- "Chapter I — The Supreme Court", articles[1] is Art. 2 — convert its
-- one history entry from flat `text` to paragraph + ordered list.
UPDATE legal_acts
SET data = json_set(
      data,
      '$.chapters[0].articles[1].history[0].content',
      json('[{"type":"paragraph","text":"The Supreme Court shall sit in such Chambers as the Crown may establish, organised as follows:"},{"type":"list","style":"ordered","items":[{"text":"the Civil Chamber, competent to hear civil disputes between citizens and disputes between citizens and the offices of state;"},{"text":"the Criminal Chamber, competent to hear such criminal matters as are referred to it under the Penal Code."}]}]')
    ),
    updated_at = '2026-06-23T00:00:00.000Z'
WHERE slug = 'judicial-power';

-- Penal Code, Art. 3 (Penalties) — chapters[0] is "Chapter I — General
-- Provisions", articles[2] is Art. 3 — convert both history entries
-- (v1 and v2) so the version-compare diff keeps demonstrating the
-- v1->v2 "confiscation" addition under the new content model too.
UPDATE legal_acts
SET data = json_set(
      json_set(
        data,
        '$.chapters[0].articles[2].history[0].content',
        json('[{"type":"paragraph","text":"Penalties under this Code include the following, applied according to the gravity of the offence:"},{"type":"list","style":"unordered","items":[{"text":"censure;"},{"text":"fine;"},{"text":"restriction of access to the offices of state;"},{"text":"banishment."}]}]')
      ),
      '$.chapters[0].articles[2].history[1].content',
      json('[{"type":"paragraph","text":"Penalties under this Code include the following, applied according to the gravity of the offence:"},{"type":"list","style":"unordered","items":[{"text":"censure;"},{"text":"fine;"},{"text":"confiscation of unlawfully held property;"},{"text":"restriction of access to the offices of state;"},{"text":"banishment."}]}]')
    ),
    updated_at = '2026-06-23T00:00:00.000Z'
WHERE slug = 'penal-code';
