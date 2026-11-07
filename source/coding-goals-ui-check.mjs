// Runs the full Tasks page in the existing loopback-only browser fixture.
process.argv.push('--goals-only');
await import('./coding-ui-check.mjs');
