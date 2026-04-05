import type { FC } from 'react'
import { useMessageTiming } from '@assistant-ui/react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '../../lib/utils'

const formatTimingMs = (ms: number | undefined): string => {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export const MessageTiming: FC<{
  className?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}> = ({ className, side = 'right' }) => {
  const timing = useMessageTiming()
  if (timing?.totalStreamTime === undefined) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-slot="message-timing-trigger"
          aria-label="Message timing"
          className={cn(
            'flex items-center rounded-md p-1 font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
            className
          )}
        >
          {formatTimingMs(timing.totalStreamTime)}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={8}
        data-slot="message-timing-popover"
        className="rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-md"
      >
        <div className="grid min-w-35 gap-1.5 text-xs">
          {timing.firstTokenTime !== undefined ? (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">First token</span>
              <span className="font-mono tabular-nums">
                {formatTimingMs(timing.firstTokenTime)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Total</span>
            <span className="font-mono tabular-nums">
              {formatTimingMs(timing.totalStreamTime)}
            </span>
          </div>
          {timing.tokensPerSecond !== undefined ? (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Speed</span>
              <span className="font-mono tabular-nums">
                {timing.tokensPerSecond.toFixed(1)} tok/s
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Chunks</span>
            <span className="font-mono tabular-nums">{timing.totalChunks}</span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
