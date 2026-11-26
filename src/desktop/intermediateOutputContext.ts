import { createContext } from 'react'

// Presentation policy only: final responses and Workspace previews keep their
// existing actions. All descendants of the execution log share the compact UI.
export const IntermediateOutputContext = createContext(false)
