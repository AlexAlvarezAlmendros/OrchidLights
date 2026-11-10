/**
 * The assistant measured against a real model. Kept out of `pnpm test` on
 * purpose: it spends tokens, and a test suite that costs money on every run
 * is one somebody switches off. Run it through server/test/ai-eval.sh, which
 * starts a throwaway desk for each scenario and puts the key on it.
 */

import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../vite.config'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['eval/**/*.eval.ts'],
      environment: 'node',
      /* A turn that builds a show is minutes, not milliseconds. */
      testTimeout: 15 * 60 * 1000,
      setupFiles: [],
    },
  }),
)
