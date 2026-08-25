/**
 * Shared test bootstrap, for both environments.
 *
 * jest-dom's matchers (toBeVisible, toBeDisabled...) load unconditionally:
 * they only extend `expect`, so the node-environment tests pay nothing for
 * them. Anything DOM-shaped stays out of here -- a pure-logic test that
 * needs a document is a test in the wrong file.
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

/* Unmount between tests: a component left mounted keeps its timers and its
   subscriptions, and the leak shows up as another test's flake. */
afterEach(cleanup)
