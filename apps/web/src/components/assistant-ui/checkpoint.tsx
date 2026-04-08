import type { HTMLAttributes } from 'react'
import { BookmarkIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

export type CheckpointProps = HTMLAttributes<HTMLDivElement> & {
  label?: string
}

export function Checkpoint({
  className,
  label = 'Recovered session history. New messages continue below.',
  ...props
}: CheckpointProps): JSX.Element {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-(--thread-max-width) px-2 py-2 text-muted-foreground',
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2 text-xs">
        <BookmarkIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">{label}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    </div>
  )
}
