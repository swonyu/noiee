# Core project skill checks

Run from the checkout:

```sh
python3 -B tooling/generate_project_skills.py --check
python3 -B tooling/tests/test_project_skills_catalog.py
python3 -B tooling/integration/core-skills/run.py
```

The reviewed inputs are `tooling/bundled-skills/catalog.json` and its six `SKILL.md` files. The first three skills retain their original exact bytes and SHA-256 values. File work, document writing and tabular data analysis are procedures for tools actually available to the task. They add no Office integration, converter, computation engine, executable, access grant or account connection.

`tooling/generate_project_skills.py` deterministically embeds hashed/base64 text in `source/ProjectSkills.swift` and the frozen ID list in existing `source/agent.mjs`. The native ID list derives from those payloads; the JS tool schema and validator share the generated constant. Run the generator without `--check` after editing reviewed inputs, inspect its diff, and run the checks before building. Runtime operation never reads an external Markdown path. Keeping inputs under tooling preserves the release adapter's flat runtime source namespace; no new resource import or release guard exception is needed.

The successor runner verifies historical template hashes from `mcp-skills/TEMPLATES.json`. It preserves their assertions, records every generated fixture and exact adaptation, and adds:

- Native: exact six-entry catalog/source byte equality, native request acceptance/refusal, each skill's install/read/duplicate and changed/unmanaged conflicts, plus actual Stop during each pending publication. This totals 34 named cases, including all 26 historical cases.
- Agent: the seven historical dispatch and durable-receipt cases plus shared all-ID validation and every skill's signed admission/native installation/read. Total: nine tests.
- Tools: the four historical mock-DOM behaviors with six catalog rows plus exact routing for all six Install/Read pairs. Total: five tests. This is not live UI acceptance.

Fixtures use generated private Caches directories and retain receipts under `.artifacts/integration/core-skills-*`. Network/model fetches are blocked in the Agent fixture. No installed app, user stores, account, original project installation, permission setting or live model is touched. Existing native approval, scope isolation, no-overwrite, Stop, and uncertain-outcome behavior remain unchanged. Generator mutation tests use disposable copies and verify that `--check` detects drift without rewriting inputs.

These focused checks do not establish model skill selection quality, document output quality, real Office support, or installed-app acceptance. Full native compilation and release qualification remain separate gates.
