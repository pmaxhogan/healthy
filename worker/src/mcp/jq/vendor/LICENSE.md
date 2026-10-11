# Third-party notices for the vendored jq engine

`jq.wasm` and `jq-glue.mjs` are derived by `scripts/build-jq-wasm.mjs` from the
npm package [`jq-wasm`](https://github.com/owenthereal/jq-wasm) (the version is
in `manifest.json`). `jq-glue.mjs` is its JavaScript glue, verbatim; `jq.wasm`
is its WebAssembly build with fuel metering added and the memory maximum
lowered. That build compiles:

- **jq** — <https://github.com/jqlang/jq>, MIT licence, copyright Stephen Dolan
  and the jq contributors. jq's `COPYING` also covers the parts of it under
  their own permissive terms (David M. Gay's `dtoa`, the ICU-licensed
  `decNumber` library).
- **Oniguruma** — <https://github.com/kkos/oniguruma>, BSD 2-Clause licence,
  copyright K.Kosako.

## jq-wasm

```
Copyright (c) 2024 Owen Ou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
