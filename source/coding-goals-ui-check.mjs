// Runs the actual Tasks page: Goal admission regressions plus responsive inspector and callback fixtures.
// Transport and result navigation are fake; no app stores, native lifecycle or model are used.
process.argv.push('--goals-only');
await import('./coding-ui-check.mjs');
