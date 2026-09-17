import { describe, expect, it } from 'vitest'
import { partitionCursorBuiltinTools } from '../handlers/agent/dynamicTools'
import { buildToolArgs } from '../handlers/agent/toolBuilders'
import { findToolByAlias, listBuiltinLlmTools, listRegisteredTools } from '../handlers/agent/toolRegistry'
import { buildExecToolResult, buildLocalToolResult, buildToolResultText } from '../handlers/agent/toolResults'
import { buildExecArgs, mapToolName, mapToolToExecArgs, resolveToolCall } from '../handlers/agent/tools'

/**
 * 3.19.19 补齐的原生工具:LLM 名 → cursorToolType → execArgsType 的解析链路,
 * 以及它们在 dynamicToolProfile=final 下的静态/动态归属。
 */

const CASES = [
  { name: 'ConnectScm', cursorToolType: 'connectScmToolCall', execArgsType: null },
  { name: 'CreateGoal', cursorToolType: 'createGoalToolCall', execArgsType: null },
  { name: 'UpdateGoal', cursorToolType: 'updateGoalToolCall', execArgsType: null },
  { name: 'SearchConversations', cursorToolType: 'searchConversationsToolCall', execArgsType: 'conversationSearchArgs' },
  { name: 'SetActiveBranch', cursorToolType: 'setActiveBranchToolCall', execArgsType: null },
  { name: 'WriteShellStdin', cursorToolType: 'writeShellStdinToolCall', execArgsType: 'writeShellStdinArgs' },
  { name: 'McpAuth', cursorToolType: 'mcpAuthToolCall', execArgsType: null },
] as const

describe('native tool resolution', () => {
  it.each(CASES)('resolves $name to $cursorToolType / $execArgsType', ({ name, cursorToolType, execArgsType }) => {
    expect(mapToolName(name)).toBe(cursorToolType)
    expect(mapToolToExecArgs(cursorToolType)).toBe(execArgsType)
    expect(findToolByAlias(name)?.canonicalName).toBe(name)
  })

  it('keeps every cursorToolType unique except the shared edit channel', () => {
    const byType = new Map<string, string[]>()
    for (const entry of listRegisteredTools()) {
      byType.set(entry.cursorToolType, [...(byType.get(entry.cursorToolType) ?? []), entry.canonicalName])
    }
    const shared = [...byType.entries()].filter(([, names]) => names.length > 1)
    expect(shared.map(([type]) => type)).toEqual(['editToolCall'])
  })
})

describe('native tool args', () => {
  it('splits ConnectScm github_repo into the github oneof target', () => {
    expect(buildToolArgs('ConnectScm', { github_repo: 'cursor/cursor' }, 'call-1')).toEqual({
      target: { case: 'github', value: { repository: { owner: 'cursor', repo: 'cursor' } } },
      toolCallId: 'call-1',
    })
  })

  it('omits the ConnectScm target when no repository was named', () => {
    expect(buildToolArgs('ConnectScm', {}, 'call-1')).toEqual({ toolCallId: 'call-1' })
  })

  it('maps UpdateGoal status names onto the GoalStatus enum', () => {
    expect(buildToolArgs('UpdateGoal', { status: 'active' }, 'call-1')).toEqual({ status: 1 })
    expect(buildToolArgs('UpdateGoal', { status: 'complete' }, 'call-1')).toEqual({ status: 3 })
    expect(() => buildToolArgs('UpdateGoal', { status: 'paused' }, 'call-1')).toThrow(/must be 'active' or 'complete'/)
  })

  it('clamps the SearchConversations limit into the 1-100 window', () => {
    expect(buildExecArgs('SearchConversations', { query: 'byok', limit: 500 }, 'call-1')).toEqual({
      query: 'byok',
      toolCallId: 'call-1',
      limit: 100,
    })
    expect(buildExecArgs('SearchConversations', { query: 'byok' }, 'call-1')).toEqual({
      query: 'byok',
      toolCallId: 'call-1',
    })
  })

  it('accepts numeric-string shell ids for WriteShellStdin and rejects missing ones', () => {
    expect(buildExecArgs('WriteShellStdin', { shell_id: '7', chars: 'y\n' }, 'call-1')).toEqual({
      shellId: 7,
      chars: 'y\n',
    })
    expect(() => buildToolArgs('WriteShellStdin', { chars: 'y\n' }, 'call-1')).toThrow(/shell_id/)
  })

  it('carries the SetActiveBranch update the client tracks the branch from', () => {
    const updates = findToolByAlias('SetActiveBranch')?.buildLocalUpdates?.(
      { path: '/repo', branchName: 'feature/x' },
      'call-1',
    )
    expect(updates).toEqual([{ case: 'activeBranchChange', value: { path: '/repo', branchName: 'feature/x' } }])
  })
})

describe('native tool results', () => {
  it('unpacks a conversation search exec result into hits', () => {
    const result = buildExecToolResult(
      'searchConversationsToolCall',
      { conversationSearchResult: { success: { hits: [{ conversationId: 'c1', title: 'BYOK', source: 1 }] } } },
      { query: 'byok' },
    )
    expect(result.result.case).toBe('success')
    expect(buildToolResultText('searchConversationsToolCall', result, { query: 'byok' })).toContain('BYOK')
  })

  it('reports a missing conversation search result as an error naming the query', () => {
    const result = buildExecToolResult('searchConversationsToolCall', {}, { query: 'byok' })
    expect(result.result.case).toBe('error')
    expect(String(result.result.value.error)).toContain('byok')
  })

  it('unpacks a stdin write result and points the model back at AwaitShell', () => {
    const result = buildExecToolResult(
      'writeShellStdinToolCall',
      { writeShellStdinResult: { success: { shellId: 7, terminalFileLengthBeforeInputWritten: 120 } } },
      { shellId: 7, chars: 'y\n' },
    )
    expect(result.result.case).toBe('success')
    expect(buildToolResultText('writeShellStdinToolCall', result, { shellId: 7, chars: 'y\n' })).toContain('AwaitShell')
  })

  it('resolves goal and branch tools locally', () => {
    expect(buildLocalToolResult('createGoalToolCall', { objective: 'ship it' }).result.case).toBe('success')
    expect(buildLocalToolResult('updateGoalToolCall', { status: 3 }).result).toEqual({ case: 'success', value: { status: 3 } })
    expect(buildLocalToolResult('setActiveBranchToolCall', {}).result.case).toBe('success')
  })
})

describe('mcp_auth routing', () => {
  it('routes the synthetic mcp_auth namespace tool to the authorization handshake', () => {
    const resolved = resolveToolCall(
      'CallDynamicTool',
      { namespace: 'user-linear', toolName: 'mcp_auth', arguments: {} },
      [{ name: 'user-linear-search', toolName: 'search', serverIdentifier: 'user-linear' }],
    )
    expect(resolved.cursorToolType).toBe('mcpAuthToolCall')
    expect(resolved.sanitizedInput).toEqual({ serverIdentifier: 'user-linear' })
    expect(resolved.resolutionError).toBeUndefined()
    expect(buildToolArgs('mcp_auth', resolved.sanitizedInput, 'call-1')).toEqual({
      serverIdentifier: 'user-linear',
      toolCallId: 'call-1',
    })
  })

  it('keeps McpAuth out of the LLM-facing builtin catalog', () => {
    expect(listBuiltinLlmTools('anthropic').some(tool => tool.name === 'McpAuth')).toBe(false)
  })
})

describe('final profile placement', () => {
  const dynamicNames = (provider: 'anthropic') =>
    partitionCursorBuiltinTools(listBuiltinLlmTools(provider), true).dynamicTools.map(tool => tool.tool)

  it('puts every newly added tool into the cursor dynamic namespace', () => {
    const dynamic = dynamicNames('anthropic')
    for (const name of ['ConnectScm', 'CreateGoal', 'UpdateGoal', 'SearchConversations', 'SetActiveBranch', 'WriteShellStdin'])
      expect(dynamic).toContain(name)
  })

  it('keeps the core editing and discovery tools static', () => {
    const { staticTools } = partitionCursorBuiltinTools(listBuiltinLlmTools('anthropic'), true)
    const staticNames = staticTools.map(tool => tool.name)
    for (const name of ['Shell', 'Read', 'Write', 'Grep', 'Glob', 'GetDynamicTools', 'CallDynamicTool'])
      expect(staticNames).toContain(name)
  })

  it('carries ConnectScm concise static context from its registry entry', () => {
    const connectScm = partitionCursorBuiltinTools(listBuiltinLlmTools('anthropic'), true)
      .dynamicTools
      .find(tool => tool.tool === 'ConnectScm')
    expect(connectScm?.conciseStaticContext).toBe('When user is blocked on connecting to GitHub.')
  })
})
