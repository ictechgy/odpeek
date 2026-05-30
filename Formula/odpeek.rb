# Homebrew formula — odpeek
#
# 배포 절차:
#   1) npm publish 로 0.1.0을 npm 레지스트리에 올린다.
#   2) 아래 sha256을 실제 값으로 교체한다:
#        curl -sL https://registry.npmjs.org/odpeek/-/odpeek-0.1.0.tgz | shasum -a 256
#   3) 이 파일을 별도 tap 저장소(homebrew-tap)의 Formula/ 아래에 둔다.
#   4) 사용자는 `brew install ictechgy/tap/odpeek` 로 설치한다.
class Odpeek < Formula
  desc "Expose Open Design's local web UI to your Tailscale tailnet for mobile viewing"
  homepage "https://github.com/ictechgy/odpeek"
  url "https://registry.npmjs.org/odpeek/-/odpeek-0.1.0.tgz"
  sha256 "REPLACE_WITH_NPM_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "Open Design", shell_output("#{bin}/odpeek --help")
  end
end
