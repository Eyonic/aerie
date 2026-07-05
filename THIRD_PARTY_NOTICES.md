# Third-Party Notices

Aerie includes, ports, or depends on third-party software and data. The
notices below apply in addition to the Aerie [LICENSE](LICENSE).

## AMD FidelityFX Super Resolution 1.0

`web/src/lib/upscaler.ts` contains a WebGL2/GLSL port of the EASU and RCAS
passes from `ffx_fsr1.h`, part of
[AMD FidelityFX Super Resolution 1.0](https://github.com/GPUOpen-Effects/FidelityFX-FSR).

```
Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

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

## OpenStreetMap

Map data is © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors, made available under the
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

Map tiles are proxied from `tile.openstreetmap.org` and their use is subject
to the [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
Operators deploying Aerie at scale should configure their own tile source
rather than relying on the OSMF public tile servers for heavy use.

## Dependency licenses

| Package     | License                                                    |
| ----------- | ---------------------------------------------------------- |
| hls.js      | Apache-2.0                                                  |
| sharp       | Apache-2.0 (bundles libvips, LGPL-3.0, dynamically linked)  |
| leaflet     | BSD-2-Clause                                                |
| typescript  | Apache-2.0                                                  |

All other runtime dependencies (react, express, better-sqlite3, etc.) are
licensed under the MIT License. See each package's own repository for its
full license text.
