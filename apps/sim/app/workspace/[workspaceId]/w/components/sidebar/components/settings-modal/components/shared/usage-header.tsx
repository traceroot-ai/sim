'use client'

import type { ReactNode } from 'react'
import { Badge, Progress } from '@/components/ui'
import { cn } from '@/lib/utils'

const GRADIENT_BADGE_STYLES =
  'gradient-text h-[1.125rem] rounded-[6px] border-gradient-primary/20 bg-gradient-to-b from-gradient-primary via-gradient-secondary to-gradient-primary px-2 py-0 font-medium text-xs cursor-pointer'

interface UsageHeaderProps {
  title: string
  gradientTitle?: boolean
  showBadge?: boolean
  badgeText?: string
  onBadgeClick?: () => void
  rightContent?: ReactNode
  current: number
  limit: number
  progressValue?: number
  seatsText?: string
}

export function UsageHeader({
  title,
  gradientTitle = false,
  showBadge = false,
  badgeText,
  onBadgeClick,
  rightContent,
  current,
  limit,
  progressValue,
  seatsText,
}: UsageHeaderProps) {
  const progress = progressValue ?? (limit > 0 ? Math.min((current / limit) * 100, 100) : 0)

  return (
    <div className='rounded-[8px] border bg-background p-3 shadow-xs'>
      <div className='space-y-2'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <span
              className={cn(
                'font-medium text-sm',
                gradientTitle
                  ? 'gradient-text bg-gradient-to-b from-gradient-primary via-gradient-secondary to-gradient-primary'
                  : 'text-foreground'
              )}
            >
              {title}
            </span>
            {showBadge && badgeText ? (
              <Badge className={GRADIENT_BADGE_STYLES} onClick={onBadgeClick}>
                {badgeText}
              </Badge>
            ) : null}
            {seatsText ? (
              <span className='text-muted-foreground text-xs'>({seatsText})</span>
            ) : null}
          </div>
          <div className='flex items-center gap-1 text-xs tabular-nums'>
            {rightContent ?? (
              <span className='text-muted-foreground'>
                ${current.toFixed(2)} / ${limit}
              </span>
            )}
          </div>
        </div>

        <Progress value={progress} className='h-2' />
      </div>
    </div>
  )
}
