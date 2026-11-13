// Small animation helpers (no libraries): tweened numbers, change detection,
// and FLIP list reordering. All respect the OS "reduce motion" setting.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/** Smoothly tween a number towards `target` (counts up from 0 on first show). */
export function useAnimatedNumber(target: number, duration = 700): number {
  const [value, setValue] = useState(reducedMotion() ? target : 0)
  const from = useRef(value)
  const raf = useRef(0)
  useEffect(() => {
    if (reducedMotion()) {
      setValue(target)
      return
    }
    const start = performance.now()
    const begin = from.current
    cancelAnimationFrame(raf.current)
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const v = begin + (target - begin) * easeOutCubic(t)
      from.current = v
      setValue(v)
      if (t < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, duration])
  return value
}

/**
 * Returns the change since the previous value (and a key that changes with it,
 * so a CSS animation can replay). Ignores the very first value.
 */
export function useChange(value: number, resetKey: unknown): { delta: number; key: number } {
  const prev = useRef<{ value: number; resetKey: unknown } | undefined>(undefined)
  const [state, setState] = useState({ delta: 0, key: 0 })
  useEffect(() => {
    const p = prev.current
    if (p && p.resetKey === resetKey && p.value !== value) setState((s) => ({ delta: value - p.value, key: s.key + 1 }))
    if (!p || p.resetKey !== resetKey) setState({ delta: 0, key: 0 })
    prev.current = { value, resetKey }
  }, [value, resetKey])
  return state
}

/**
 * FLIP animation for a list whose order changes: children that should animate
 * carry a `data-flip-id` attribute; this slides them from their old position.
 */
export function useFlip<T extends HTMLElement>(deps: unknown) {
  const ref = useRef<T>(null)
  const last = useRef(new Map<string, DOMRect>())
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const items = [...el.querySelectorAll<HTMLElement>('[data-flip-id]')]
    const next = new Map<string, DOMRect>()
    for (const item of items) {
      const id = item.dataset.flipId!
      const rect = item.getBoundingClientRect()
      next.set(id, rect)
      const before = last.current.get(id)
      if (!before || reducedMotion()) continue
      const dy = before.top - rect.top
      if (Math.abs(dy) < 1) continue
      item.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
    last.current = next
  }, [deps])
  return ref
}
