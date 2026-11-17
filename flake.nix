{
  inputs.crossgram = {
    url = "github:std-microblock/crossgram";
    flake = false;
  };
  outputs = inputs@{
    self, nixpkgs, flake-parts, crossgram,
  }: flake-parts.lib.mkFlake { inherit inputs; } {
    systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    perSystem = { pkgs, ... }: {
      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [];
        nativeBuildInputs = with pkgs; [ jq nodejs_24 yarn-berry ];
      };
      packages.default = pkgs.stdenv.mkDerivation {
        name = "crossgram-packages";
        src = crossgram;
        nativeBuildInputs = with pkgs; [ jq nodejs yarn-berry yarn-berry.yarnBerryConfigHook ];

        missingHashes = ./missing-hashes.json;
        yarnOfflineCache = pkgs.yarn-berry.fetchYarnBerryDeps {
          src = crossgram;
          missingHashes = ./missing-hashes.json;
          hash = "sha256-TIuFaxbFGp/8iGvZrnTC9mzcMVzyiFq0lTOns4zav0k=";
        };

        YARN_ENABLE_SCRIPTS = "0";
        dontYarnBerryPatchShebangs = true;
        dontBuild = true;

        installPhase = ''
          mkdir -p "$out"

          pack() {
            local dir=$1 name version file
            name=$(jq -er .name "$dir/package.json")
            version=$(jq -er .version "$dir/package.json")
            file="''${name#@}"
            file="''${file/\//-}-$version.tgz"
            (cd "$dir" && yarn pack --out "$out/$file")
          }

          yarn workspaces list --json | jq -er .location | while IFS= read -r location; do
            pack "$PWD/$location"
          done

          grep -o '~/.yarn/patches/[^"#]*\.patch' "$PWD/yarn.lock" | sort -u | while IFS= read -r patch; do
            base=$(basename "$patch" .patch)
            [[ $base =~ ^(.+)-npm-(.+)-[0-9a-f]{10}$ ]]
            slug=''${BASH_REMATCH[1]}
            if [[ $slug == @* ]]; then
              name="''${slug%%-*}/''${slug#*-}"
            else
              name=$slug
            fi
            installed="$PWD/node_modules/$name"
            touch "$installed/yarn.lock"
            pack "$installed"
          done
        '';
      };
    };
  };
}
