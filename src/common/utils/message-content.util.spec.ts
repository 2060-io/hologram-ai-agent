import { contentToText } from './message-content.util'

describe('contentToText', () => {
  it('passes strings through', () => {
    expect(contentToText('hello')).toBe('hello')
  })

  it('extracts text from Responses API content-block arrays', () => {
    expect(contentToText([{ type: 'text', text: 'Hey! How can I help?', index: 0 }])).toBe('Hey! How can I help?')
  })

  it('joins multiple blocks and ignores non-text ones', () => {
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: 'x' },
        'b',
        { type: 'text', text: 'c' },
      ]),
    ).toBe('abc')
  })

  it('handles null/undefined', () => {
    expect(contentToText(null)).toBe('')
    expect(contentToText(undefined)).toBe('')
  })

  it('stringifies plain objects instead of producing [object Object]', () => {
    expect(contentToText({ some: 'object' })).toBe('{"some":"object"}')
  })
})
