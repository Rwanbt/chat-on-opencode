#!/usr/bin/env node
import { runPromotionTransition } from '../src/promotion-transition.mjs'

const result = runPromotionTransition()
process.stdout.write(JSON.stringify(result) + '\n')
process.exit(result.status === 'NO_GO' ? 1 : 0)
