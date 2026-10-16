import { beforeEach } from 'vitest'

import { installBrowserStubs, resetBrowserStubs } from './helpers/browser'

installBrowserStubs()
resetBrowserStubs()

beforeEach(() => {
  resetBrowserStubs()
})
