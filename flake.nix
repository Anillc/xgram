{
  inputs.crossgram = {
    url = "github:std-microblock/crossgram/pull/19/head";
    flake = false;
  };
  outputs = inputs@{
    self, nixpkgs, flake-parts, crossgram,
  }: flake-parts.lib.mkFlake { inherit inputs; } {
    systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    perSystem = { self', pkgs, ... }: let
      xgram = pkgs.writeShellApplication {
        name = "xgram";
        runtimeInputs = with pkgs; [ yarn-berry ];
        text = ''
          cd "$XGRAM_NIX"
          exec yarn start
        '';
      };
    in {
      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [];
        nativeBuildInputs = with pkgs; [ jq nodejs unzip yarn-berry xgram ];
        shellHook = ''
          if [[ ! -e node_modules || -L node_modules ]]; then
            ln -sfn ${self'.packages.yarn-deps}/node_modules node_modules
          else
            echo "xgram: using existing node_modules (development mode)"
          fi
          ln -sfn ${self'.packages.crossgram-packages} tarballs
          yarn build
          export XGRAM_NIX="$PWD"
        '';
      };

      packages.crossgram-packages = pkgs.stdenv.mkDerivation {
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
          node --import tsx scripts/build-webui.mjs

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
            # Yarn refuses to pack node_modules packages unless they look standalone.
            touch "$installed/yarn.lock"
            pack "$installed"
          done
        '';
      };

      packages.yarn-deps = pkgs.stdenv.mkDerivation {
        name = "xgram-yarn-deps";
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./package.json
            ./.yarnrc.yml
            ./yarn.lock
          ];
        };
        nativeBuildInputs = with pkgs; [ nodejs yarn-berry cacert ];

        outputHashMode = "recursive";
        outputHash = "sha256-hvZCU2Sr6mvQMuWwUu0cacm8lWppk8T/MURj9Gnlxpk=";
        dontFixup = true;

        YARN_ENABLE_SCRIPTS = "0";
        YARN_ENABLE_GLOBAL_CACHE = "0";

        buildPhase = ''
          export HOME=$(mktemp -d)
          rm -rf tarballs
          cp -r ${self'.packages.crossgram-packages} tarballs
          yarn install --immutable
        '';

        installPhase = ''
          mkdir -p "$out"
          cp -r node_modules "$out/"
        '';
      };
    };
  };
}
