import { Component, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';

export default class WorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="loading-screen initial-loading">
          <TriangleAlert size={30} />
          <div style={{ textAlign: 'center' }}>
            <h2>화면을 불러오지 못했어요.</h2>
            <p style={{ marginTop: 8 }}>다시 열어주세요. 서버에 저장한 데이터는 유지됩니다.</p>
          </div>
          <button className="button secondary" onClick={() => window.location.reload()}>
            <RotateCcw size={16} />
            화면 다시 열기
          </button>
        </main>
      );
    return this.props.children;
  }
}
