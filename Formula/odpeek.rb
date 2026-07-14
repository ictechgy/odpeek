# Homebrew formula — odpeek
#
# 배포: ictechgy/homebrew-tap 의 Formula/odpeek.rb 와 동기화한다.
# 버전 업 시 url 의 버전과 sha256(`curl -sL <tarball> | shasum -a 256`)을 함께 갱신한다.
# 사용자는 `brew install ictechgy/tap/odpeek` 로 설치한다.
class Odpeek < Formula
  desc "Expose Open Design's local UI to phones via Tailscale or Cloudflare"
  homepage "https://github.com/ictechgy/odpeek"
  url "https://registry.npmjs.org/odpeek/-/odpeek-0.3.1.tgz"
  sha256 "80f7fade377e05ef37678122434bcee2f1797eef3b36b73aa19e31b5743e22be"
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
