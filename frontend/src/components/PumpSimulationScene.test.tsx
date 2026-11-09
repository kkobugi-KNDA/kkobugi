import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PumpSimulationScene from './PumpSimulationScene';

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class UnavailableRenderer {
    constructor() {
      throw new Error('WebGL unavailable in this test');
    }
  }

  return { ...actual, WebGLRenderer: UnavailableRenderer };
});

describe('펌프 3D 화면', () => {
  it('WebGL이 없어도 재생 안내와 제공된 세 부품의 검토 버튼을 유지한다', () => {
    render(<PumpSimulationScene hasSignal={false} selectedPartId={null} onSelectPart={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('이 환경에서는 3D를 표시할 수 없어요.');
    expect(screen.getByText('CSV 재생과 모델 점검은 계속 사용할 수 있어요.')).toBeInTheDocument();
    for (const label of ['임펠러', '베어링', '메커니컬 씰']) {
      expect(screen.getByRole('button', { name: `${label} 검토` })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  });

  it('부품 위에서 드래그하면 검토를 열지 않고 클릭하거나 키보드로 선택할 때만 연다', () => {
    const selectPart = vi.fn();

    render(
      <PumpSimulationScene hasSignal={false} selectedPartId={null} onSelectPart={selectPart} />,
    );
    const button = screen.getByRole('button', { name: '임펠러 검토' });

    fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    fireEvent(button, new MouseEvent('pointerup', { bubbles: true, clientX: 60, clientY: 15 }));
    fireEvent.click(button, { detail: 1 });
    expect(selectPart).not.toHaveBeenCalled();
    fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    fireEvent(button, new MouseEvent('pointerup', { bubbles: true, clientX: 11, clientY: 11 }));
    expect(selectPart).toHaveBeenCalledExactlyOnceWith('part-1');
    fireEvent.click(button, { detail: 0 });
    expect(selectPart).toHaveBeenCalledTimes(2);
  });

  it('모델 신호는 펌프 전체에 표시하고 선택한 부품을 고장으로 표시하지 않는다', () => {
    const { container } = render(
      <PumpSimulationScene hasSignal selectedPartId="part-2" onSelectPart={vi.fn()} />,
    );

    expect(container.firstElementChild).toHaveClass('has-signal');
    expect(
      screen.getByText('붉은색은 펌프 전체의 점검 신호예요. 고장 부품을 특정한 표시는 아닙니다.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '베어링 검토' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('부품 전체 보기는 형상 확인용으로 안내하고 펌프 이상 색을 부품에 옮기지 않는다', () => {
    const { container } = render(
      <PumpSimulationScene
        hasSignal
        selectedPartId="part-1"
        onSelectPart={vi.fn()}
        viewMode="parts"
      />,
    );

    expect(screen.getByRole('heading', { name: '부품 전체' })).toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass('has-signal');
    expect(
      screen.getByText('임펠러 · 베어링 · 메커니컬 씰의 형상을 함께 확인해요.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/붉은색은 펌프 전체/)).not.toBeInTheDocument();
  });
});
