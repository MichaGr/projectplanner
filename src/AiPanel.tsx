import { FormEvent, useMemo, useState } from 'react';
import { AiRequestSettings, ApiError, AiChatResponse, applyChatProposalWithSettings, ChatProposal, sendChatMessage } from './api';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

type AiPanelProps = {
  projectId: string;
  activeTabId: string;
  selectedNodeIds: string[];
  visibleNodeIds: string[];
  openaiApiKey?: string;
  supermemoryApiKey?: string;
  disabled?: boolean;
  onApplied: (project: unknown) => void;
};

const uid = () => `ai-${Math.random().toString(36).slice(2, 10)}`;

export function AiPanel({
  projectId,
  activeTabId,
  selectedNodeIds,
  visibleNodeIds,
  openaiApiKey,
  supermemoryApiKey,
  disabled = false,
  onApplied,
}: AiPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: 'assistant',
      content: 'Ask for a breakdown, a graph update draft, or a state summary. I will use the current scope and selected nodes as context.',
    },
  ]);
  const [composer, setComposer] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApplyingProposal, setIsApplyingProposal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<AiChatResponse | null>(null);
  const [proposal, setProposal] = useState<ChatProposal | null>(null);

  const activeScopeLabel = useMemo(() => lastResponse?.graphContext.scope.activeScopeTitle ?? 'Current scope', [lastResponse]);

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextMessage = composer.trim();
    if (!nextMessage || isSubmitting || disabled) {
      return;
    }

    setError(null);
    setIsSubmitting(true);
    setMessages((current) => [...current, { id: uid(), role: 'user', content: nextMessage }]);
    setComposer('');

    try {
      const response = await sendChatMessage({
        projectId,
        message: nextMessage,
        uiContext: {
          activeTabId,
          selectedNodeIds,
          visibleNodeIds,
        },
        settings: {
          openaiApiKey,
          supermemoryApiKey,
        } satisfies AiRequestSettings,
      });
      setLastResponse(response);
      setProposal(response.proposal);
      setMessages((current) => [...current, { id: uid(), role: 'assistant', content: response.response }]);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not reach the AI service.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const applyProposal = async () => {
    if (!proposal || isApplyingProposal) {
      return;
    }

    setError(null);
    setIsApplyingProposal(true);
    try {
      const response = await applyChatProposalWithSettings(proposal.proposalId, {
        openaiApiKey,
        supermemoryApiKey,
      });
      onApplied(response.project);
      setMessages((current) => [
        ...current,
        { id: uid(), role: 'assistant', content: `Applied proposal "${proposal.summary}" to the workflow graph.` },
      ]);
      setProposal(null);
    } catch (error) {
      if (error instanceof ApiError) {
        setError(error.message);
      } else {
        setError(error instanceof Error ? error.message : 'Could not apply the proposal.');
      }
    } finally {
      setIsApplyingProposal(false);
    }
  };

  const criticalPath = lastResponse?.graphContext.summaries.criticalPathCandidates[0];
  const missingDetailCount = lastResponse?.graphContext.summaries.itemsMissingDetails.length ?? 0;
  const availableCount = lastResponse?.graphContext.availableTasksGlobal.length ?? 0;

  return (
    <div className="glass-panel glass-panel--stack ai-panel-shell">
      <div className="panel-header floating-panel-header">
        <h2>AI Assistant</h2>
        <span>{proposal ? 'Proposal ready' : isSubmitting ? 'Thinking' : 'Ready'}</span>
      </div>

      <div className="ai-context-card">
        <strong>{activeScopeLabel}</strong>
        <p className="muted">
          Selected: {selectedNodeIds.length > 0 ? `${selectedNodeIds.length} node${selectedNodeIds.length === 1 ? '' : 's'}` : 'none'}
        </p>
        {lastResponse ? (
          <>
            <p className="muted">Available tasks: {availableCount}</p>
            <p className="muted">Context score: {Math.round(lastResponse.contextScore * 100)}%</p>
            <p className="muted">OpenAI: {openaiApiKey?.trim() ? 'configured from Settings' : 'not configured'}</p>
            <p className="muted">Supermemory: {supermemoryApiKey?.trim() ? 'configured from Settings' : 'not configured'}</p>
            {criticalPath ? <p className="muted">Critical path candidate: {criticalPath.title}</p> : null}
            {missingDetailCount > 0 ? <p className="muted">Missing node details: {missingDetailCount}</p> : null}
          </>
        ) : (
          <p className="muted">The assistant will anchor suggestions to the current scope, selected nodes, derived dependency context, and your configured OpenAI and Supermemory keys.</p>
        )}
      </div>

      <div className="ai-dialog-panel__scroll ai-panel-scroll">
        {messages.map((message) => (
          <div key={message.id} className={['ai-message', message.role === 'assistant' ? 'is-assistant' : 'is-user'].join(' ')}>
            <span className="ai-message__role">{message.role === 'assistant' ? 'Assistant' : 'You'}</span>
            <p className="muted">{message.content}</p>
          </div>
        ))}
      </div>

      {proposal ? (
        <div className="proposal-item proposal-card--review">
          <strong>{proposal.summary}</strong>
          <p className="muted">{proposal.rationale}</p>
          <div className="proposal-targets">
            <span className="proposal-target-chip">{proposal.graphOperations.length} operation{proposal.graphOperations.length === 1 ? '' : 's'}</span>
            <span className="proposal-target-chip">{proposal.touchedNodeIds.length} touched node{proposal.touchedNodeIds.length === 1 ? '' : 's'}</span>
          </div>
          <div className="proposal-actions">
            <button type="button" className="primary-action" onClick={applyProposal} disabled={isApplyingProposal}>
              {isApplyingProposal ? 'Applying...' : 'Apply Proposal'}
            </button>
          </div>
        </div>
      ) : null}

      {lastResponse?.clarificationQuestion ? (
        <div className="glass-card">
          <h3>Clarification</h3>
          <p className="muted">{lastResponse.clarificationQuestion}</p>
        </div>
      ) : null}

      {error ? <p className="feedback feedback--error">{error}</p> : null}

      <form className="ai-composer" onSubmit={submitMessage}>
        <label className="glass-field">
          Prompt
          <textarea
            rows={4}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            placeholder="Break down the selected workstream, explain blockers, or draft an update."
            disabled={disabled || isSubmitting}
          />
        </label>
        <div className="ai-composer__actions">
          <button type="submit" className="primary-action" disabled={disabled || isSubmitting || composer.trim().length === 0}>
            {isSubmitting ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
