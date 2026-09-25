import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off'
    }
  },
  {
    // Everything the Worker program compiles: the Worker slice plus the shared
    // and server modules it imports. These must run in workerd, which has no
    // Node built-ins and, without a compatibility flag, no Node globals. Test
    // files are excluded because the Node suite legitimately uses them.
    files: ['src/worker/**/*.ts', 'src/shared/**/*.ts', 'src/server/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'process', 'stream', 'tls', 'url', 'util', 'zlib'],
        patterns: ['node:*']
      }],
      // `@cloudflare/workers-types` declares `Buffer`, `process`, `setImmediate`
      // and `clearImmediate` for the nodejs_compat surface, so the isolated type
      // program cannot catch them; without a compatibility flag none exists in
      // the deployed runtime, which makes this rule the enforceable boundary.
      'no-restricted-globals': ['error',
        { name: 'process', message: 'Node globals are unavailable in the Worker runtime; pass configuration through bindings.' },
        { name: 'Buffer', message: 'Node globals are unavailable in the Worker runtime; use Uint8Array and TextEncoder/TextDecoder.' },
        { name: 'require', message: 'CommonJS require is unavailable in the Worker runtime.' },
        { name: '__dirname', message: 'Node globals are unavailable in the Worker runtime.' },
        { name: '__filename', message: 'Node globals are unavailable in the Worker runtime.' },
        { name: 'global', message: 'Use globalThis in the Worker runtime.' },
        { name: 'setImmediate', message: 'Node globals are unavailable in the Worker runtime.' },
        { name: 'clearImmediate', message: 'Node globals are unavailable in the Worker runtime.' }
      ]
    }
  }
);
