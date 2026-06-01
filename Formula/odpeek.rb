# Homebrew formula — odpeek
#
# 배포: ictechgy/homebrew-tap 의 Formula/odpeek.rb 와 동기화한다.
# 버전 업 시 url 의 버전과 sha256(`curl -sL <tarball> | shasum -a 256`)을 함께 갱신한다.
# 사용자는 `brew install ictechgy/tap/odpeek` 로 설치한다.
class Odpeek < Formula
  desc "Expose Open Design's local web UI to your phone via Tailscale or a Cloudflare tunnel"
  homepage "https://github.com/ictechgy/odpeek"
  url "https://registry.npmjs.org/odpeek/-/odpeek-0.2.0.tgz"
  sha256 "ad093b3bd26fb832d71a3c24cdca8be51acd4eee8fce702ff7aca34ecfcc6f4a"
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
