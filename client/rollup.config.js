import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

const input = 'src/index.js';
const name = 'IBotPty';
const banner = `/*! ibbot-pty-sdk v1.0.0 | GPL-3.0-only License */`;

export default [
  // UMD锛堟祻瑙堝櫒 <script> 鐩存帴鐢級
  {
    input,
    output: {
      file: 'dist/ibbot-pty.umd.js',
      format: 'umd',
      name,
      banner,
      sourcemap: true,
      globals: { ws: 'WebSocket' }
    },
    plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs()]
  },
  {
    input,
    output: {
      file: 'dist/ibbot-pty.umd.min.js',
      format: 'umd',
      name,
      banner,
      sourcemap: true,
      globals: { ws: 'WebSocket' }
    },
    plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs(), terser()]
  },
  // ESM
  {
    input,
    output: {
      file: 'dist/ibbot-pty.esm.js',
      format: 'es',
      banner,
      sourcemap: true
    },
    external: ['ws'],
    plugins: [resolve({ preferBuiltins: false }), commonjs()]
  },
  // CJS锛圢ode锛?
  {
    input,
    output: {
      file: 'dist/ibbot-pty.cjs.js',
      format: 'cjs',
      banner,
      sourcemap: true,
      exports: 'named'
    },
    external: ['ws'],
    plugins: [resolve({ preferBuiltins: false }), commonjs()]
  }
];