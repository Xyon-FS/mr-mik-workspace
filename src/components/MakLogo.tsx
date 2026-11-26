/** Shared emoji-style mark for Workspace, Chats and the voice controls. */
import pinkLogo from '../assets/mak-nose.svg'
import chatLogo from '../assets/mak-nose-chats.svg'

export default function MakLogo({ size = 64, tone = 'pink' }: { size?: number; animated?: boolean; tone?: 'pink' | 'black' }) {
  return <img className="mak-logo" src={tone === 'black' ? chatLogo : pinkLogo} width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }} />
}
