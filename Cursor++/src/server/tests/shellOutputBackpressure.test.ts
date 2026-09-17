import { describe, expect, it } from 'vitest'
import {
  createBoundedOutputBuffer,
  SHELL_STREAM_MAX_CHARS,
} from '../handlers/agent/toolkit/results/shellOutputBuffer'

/**
 * 输出背压。
 *
 * 结果构造阶段的 head/tail 截断来得太晚 —— 在此之前 stdout/stderr 已经在堆上
 * 无上限累加完了。累加阶段就按同一套 head/tail + 省略计数策略封顶。
 */

describe('c4 累加阶段的硬上限', () => {
  it('未超上限时原样保留,不插入任何标记', () => {
    const buffer = createBoundedOutputBuffer(100)
    buffer.append('hello ')
    buffer.append('world')
    expect(buffer.text).toBe('hello world')
    expect(buffer.totalChars).toBe(11)
    expect(buffer.elidedChars).toBe(0)
  })

  it('超上限后只保留首尾,中间以省略计数替代', () => {
    const buffer = createBoundedOutputBuffer(100)
    buffer.append('H'.repeat(50))
    buffer.append('M'.repeat(1000))
    buffer.append('T'.repeat(50))

    expect(buffer.totalChars).toBe(1100)
    expect(buffer.elidedChars).toBe(1000)
    expect(buffer.text.startsWith('H'.repeat(50))).toBe(true)
    expect(buffer.text.endsWith('T'.repeat(50))).toBe(true)
    expect(buffer.text).toMatch(/\[1000 chars elided\]/)
    // 保留量封顶在 maxChars 附近,不随输入增长
    expect(buffer.text.length).toBeLessThan(160)
  })

  it('尾部窗口始终跟随最新输出', () => {
    const buffer = createBoundedOutputBuffer(20)
    for (let i = 0; i < 100; i++)
      buffer.append(`${i},`)

    expect(buffer.text.startsWith('0,1,2,3,4,')).toBe(true)
    expect(buffer.text.endsWith('98,99,')).toBe(true)
  })

  it('大量小块累加后内存占用仍然有界', () => {
    const buffer = createBoundedOutputBuffer()
    const chunk = 'x'.repeat(1024)
    for (let i = 0; i < 4096; i++)
      buffer.append(chunk)

    expect(buffer.totalChars).toBe(4096 * 1024)
    expect(buffer.text.length).toBeLessThanOrEqual(SHELL_STREAM_MAX_CHARS + 64)
    expect(buffer.elidedChars).toBe(4096 * 1024 - SHELL_STREAM_MAX_CHARS)
  })
})
