export interface StudioSession {
  version: number
  pid: number
  root: string
  run_dir: string
  raw_video: string
  events_file: string
  session_file: string
  recorder_log: string
  started_at: string
  start_epoch: number
  status: string
  stopped_at?: string
  stop_epoch?: number
  record?: {
    display?: number | null
    audio?: boolean
    cursor?: boolean
    show_clicks?: boolean
    duration?: number | null
  }
}

export interface TimelineEvent {
  type: string
  time?: number
  [key: string]: unknown
}

export interface EventsDoc {
  version: number
  recording: {
    started_at?: string
    stopped_at?: string
    start_epoch: number
    stop_epoch?: number
    duration?: number
    raw_video?: string
    [key: string]: unknown
  }
  events: TimelineEvent[]
}

export interface RunSummary {
  name: string
  run_dir: string
  raw: boolean
  final: boolean
  events: number
  session: boolean
}
