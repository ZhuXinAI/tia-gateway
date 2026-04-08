import type { ComponentProps } from 'react'
import {
  ChainOfThoughtPrimitive,
  useAuiState,
  type PartState,
  type ToolCallMessagePartStatus
} from '@assistant-ui/react'
import {
  BrainIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon
} from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { cn } from '../../lib/utils'

type ToolVisualState = 'pending' | 'running' | 'needs-input' | 'complete' | 'error' | 'cancelled'

function normalizeToolState(
  status: ToolCallMessagePartStatus | undefined,
  isError: boolean | undefined
): ToolVisualState {
  if (!status || status.type === 'complete') {
    return isError ? 'error' : 'complete'
  }

  if (status.type === 'running') {
    return 'running'
  }

  if (status.type === 'requires-action') {
    return 'needs-input'
  }

  if (status.reason === 'cancelled') {
    return 'cancelled'
  }

  if (status.reason === 'other' || status.reason === 'error') {
    return 'error'
  }

  return 'pending'
}

function statusMeta(state: ToolVisualState): {
  label: string
  className: string
  icon: JSX.Element
} {
  switch (state) {
    case 'running':
      return {
        label: 'Running',
        className: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
        icon: <ClockIcon className="size-3.5 animate-pulse" />
      }
    case 'needs-input':
      return {
        label: 'Needs input',
        className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
        icon: <ClockIcon className="size-3.5" />
      }
    case 'error':
      return {
        label: 'Failed',
        className: 'bg-destructive/10 text-destructive',
        icon: <XCircleIcon className="size-3.5" />
      }
    case 'cancelled':
      return {
        label: 'Cancelled',
        className: 'bg-muted text-muted-foreground',
        icon: <XCircleIcon className="size-3.5" />
      }
    case 'pending':
      return {
        label: 'Pending',
        className: 'bg-muted text-muted-foreground',
        icon: <CircleIcon className="size-3.5" />
      }
    case 'complete':
    default:
      return {
        label: 'Completed',
        className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        icon: <CheckCircleIcon className="size-3.5" />
      }
  }
}

function stringifyUnknown(value: unknown): string {
  if (value == null) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

type ToolCardProps = {
  part: Extract<PartState, { type: 'tool-call' }>
}

function ToolCard({ part }: ToolCardProps): JSX.Element {
  const visualState = normalizeToolState(part.status as ToolCallMessagePartStatus, part.isError)
  const meta = statusMeta(visualState)
  const argsText = part.argsText?.trim() || stringifyUnknown(part.args)
  const outputText = stringifyUnknown(part.result)
  const statusError =
    part.status.type === 'incomplete' && part.status.error != null
      ? stringifyUnknown(part.status.error)
      : ''
  const hasOutput = outputText.trim().length > 0
  const hasError = statusError.trim().length > 0
  const defaultOpen = visualState === 'running' || visualState === 'needs-input' || hasError

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="group/tool rounded-md border border-border/60 bg-transparent"
      data-slot="tool-group"
      data-variant="ghost"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/35">
        <div className="flex min-w-0 items-center gap-2">
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
          <p className="truncate text-sm font-medium text-foreground">{part.toolName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              meta.className
            )}
          >
            {meta.icon}
            {meta.label}
          </span>
          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-180" />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t border-border/60 px-3 py-3 text-xs">
        {argsText ? (
          <div>
            <p className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Input</p>
            <pre className="overflow-x-auto rounded-md border border-border/50 bg-muted/40 p-2 whitespace-pre-wrap">
              {argsText}
            </pre>
          </div>
        ) : null}

        {hasError ? (
          <div>
            <p className="mb-1 font-medium uppercase tracking-wide text-destructive">Error</p>
            <pre className="overflow-x-auto rounded-md border border-destructive/30 bg-destructive/10 p-2 whitespace-pre-wrap text-destructive">
              {statusError}
            </pre>
          </div>
        ) : null}

        {hasOutput ? (
          <div>
            <p className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Output</p>
            <pre className="overflow-x-auto rounded-md border border-border/50 bg-muted/40 p-2 whitespace-pre-wrap">
              {outputText}
            </pre>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

type ReasoningCardProps = {
  part: Extract<PartState, { type: 'reasoning' }>
}

function ReasoningCard({ part }: ReasoningCardProps): JSX.Element {
  return (
    <div className="rounded-md border border-border/60 bg-transparent p-3">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Reasoning</p>
      <p className="whitespace-pre-wrap text-sm text-foreground">{part.text}</p>
    </div>
  )
}

export function ChainOfThoughtPanel(
  props: Omit<ComponentProps<typeof ChainOfThoughtPrimitive.Root>, 'children'>
): JSX.Element {
  const collapsed = useAuiState((s) => s.chainOfThought.collapsed)
  const toolCount = useAuiState(
    (s) => s.chainOfThought.parts.filter((part) => part.type === 'tool-call').length
  )
  const reasoningCount = useAuiState(
    (s) => s.chainOfThought.parts.filter((part) => part.type === 'reasoning').length
  )

  return (
    <ChainOfThoughtPrimitive.Root
      className={cn('mb-3 rounded-lg border border-border/60 bg-transparent p-2', props.className)}
      {...props}
    >
      <ChainOfThoughtPrimitive.AccordionTrigger
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground"
      >
        <BrainIcon className="size-4 shrink-0" />
        <span className="flex-1 text-left">
          Chain of thought
          <span className="ml-2 text-xs text-muted-foreground">
            {toolCount} tool{toolCount === 1 ? '' : 's'}
            {reasoningCount > 0 ? ` · ${reasoningCount} reasoning` : ''}
          </span>
        </span>
        <ChevronDownIcon
          className={cn('size-4 transition-transform', collapsed ? 'rotate-0' : 'rotate-180')}
        />
      </ChainOfThoughtPrimitive.AccordionTrigger>

      {!collapsed ? (
        <div className="mt-2 space-y-1.5">
          <ChainOfThoughtPrimitive.Parts>
            {({ part }) => {
              if (part.type === 'tool-call') {
                return <ToolCard part={part} />
              }

              if (part.type === 'reasoning') {
                return <ReasoningCard part={part} />
              }

              return null
            }}
          </ChainOfThoughtPrimitive.Parts>
        </div>
      ) : null}
    </ChainOfThoughtPrimitive.Root>
  )
}
