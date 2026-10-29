import { runSourcePlugin } from '@conclave/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { source } from './source.js'

runSourcePlugin({ manifest, sources: [source] })
