import { describe, expect, it } from 'vitest';
import { customerAcknowledgement, CUSTOMER_ACKNOWLEDGEMENTS } from './customer-copy.ts';

const probabilities = { booking: 0, question: 0, complaint: 0, spam: 0, other: 0 };
describe('customer acknowledgement copy', () => {
  it('uses reviewed short Hebrew copy for routed messages', () => {
    expect(customerAcknowledgement({ intent: 'booking', confidence: 1, probabilities, disposition: 'route' })).toBe(CUSTOMER_ACKNOWLEDGEMENTS.booking);
    expect(customerAcknowledgement({ intent: 'question', confidence: 1, probabilities, disposition: 'route' })).toBe(CUSTOMER_ACKNOWLEDGEMENTS.question);
    expect(customerAcknowledgement({ intent: 'other', confidence: 1, probabilities, disposition: 'route' })).toBe(CUSTOMER_ACKNOWLEDGEMENTS.other);
  });
  it('uses the human copy for complaints and uncertainty, and stays silent on spam', () => {
    expect(customerAcknowledgement({ intent: 'complaint', confidence: 1, probabilities, disposition: 'human_handoff', reason: 'complaint' })).toBe(CUSTOMER_ACKNOWLEDGEMENTS.humanHandoff);
    expect(customerAcknowledgement({ intent: 'other', confidence: 0.5, probabilities, disposition: 'human_handoff', reason: 'low_confidence' })).toBe(CUSTOMER_ACKNOWLEDGEMENTS.humanHandoff);
    expect(customerAcknowledgement({ intent: 'spam', confidence: 1, probabilities, disposition: 'route' })).toBeNull();
  });
});
