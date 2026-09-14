import { renderSillyTavernMacros } from 'pmp-dsh-tavern/format'

export const name = 'tavern-prompt-example'
export const inject = ['pmpDshTavernPrompt']

// Example policy: fixed system slots, not a complete ST PromptManager emulator.
// Loading registers availability only. The user enables it per session via v3.
export function apply(ctx) {
  const prompt = ctx.get('pmpDshTavernPrompt')
  ctx.effect(() => prompt.registerComposer({
    id: 'example-manager',
    compose({ sources, runtime }) {
      const { preset, character, user } = sources.documents
      const data = character?.data ?? {}
      const options = sources.selection.character
      const sections = []
      const add = (id, text) => {
        if (typeof text !== 'string' || text === '') return
        const rendered = renderSillyTavernMacros(text, runtime.macroContext)
        if (rendered !== '') sections.push({ id, text: rendered })
      }
      // Deliberate example policy: non-marker preset prompts, then semantic fields.
      // Their original roles and depth remain source metadata, not real message roles.
      for (const [index, item] of (preset?.prompts ?? []).entries()) {
        if (item.enabled && !item.marker) add(`preset-${index}`, item.content)
      }
      if (options.preferCharacterSystemPrompt !== false) add('character-system', data.systemPrompt)
      add('user-persona', user?.description)
      add('description', data.description)
      add('personality', data.personality)
      add('scenario', data.scenario)
      add('examples', data.messageExample)
      for (const [index, entry] of runtime.loreEntries.entries()) add(`lore-${index}`, entry.content)
      if (runtime.greetingReferenceApplies === true) add('greeting-reference', sources.greeting.text)
      if (options.preferCharacterPostHistory !== false) add('post-history-approximation', data.postHistoryInstructions)
      add('depth-approximation', data.extensions?.depth_prompt?.prompt)
      // Creator notes, arbitrary extensions and imported history are not model instructions.
      return { sections, callConfig: sources.suggestedCallConfig }
    },
  }), 'example prompt composer')
}
