import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../../lib/utils'

export function TooltipProvider({
  delayDuration = 100,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>): JSX.Element {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
}

export function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>): JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={100}>
      <TooltipPrimitive.Root {...props} />
    </TooltipPrimitive.Provider>
  )
}

export function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>): JSX.Element {
  return <TooltipPrimitive.Trigger {...props} />
}

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 overflow-hidden rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}
