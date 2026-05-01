import type { GraphScanner, GraphScanResult } from '../contracts'
import { scanLaravelProject } from './project-scanner'

export const laravelGraphScanner: GraphScanner = {
  promotionEdges: ['defines'],
  scan(opts: { repoRoot: string }): GraphScanResult {
    return scanLaravelProject(opts) as GraphScanResult
  },
}
