# tests

Regression tests for the worker's schedule + timezone logic. They load a **rendered**
worker (`clients/<client>/dist/worker/src/index.js`), strip the ES `export default` block,
and exercise the pure helpers.

```bash
node render.js bluetap
node tests/dst.test.js       clients/bluetap/dist/worker/src/index.js
node tests/schedule.test.js  clients/bluetap/dist/worker/src/index.js <phoenix-client-dist>
```

`dst.test.js` is the important one: it proves the UTC offset is derived **per booking date**
(not "today") and survives a DST transition — the Chicago Nov fall-back is where a static
offset lookup silently books an hour off. A fixed-offset zone (Phoenix) cannot prove this.
