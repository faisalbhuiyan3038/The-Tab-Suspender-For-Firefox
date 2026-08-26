import Data.List
import Network.HTTP.Simple
import System.FilePath
import Data.ByteString.Lazy qualified as LBS

resDir = "fonts/"
downloadPrefix = "https://cdnjs.cloudflare.com/ajax/libs/inter-ui/3.19.3/"

fixCss :: String -> IO String
fixCss css
  | "url(\"" `isPrefixOf` css = do
    let (url, rest) = span (/='"') $ drop 5 css
        fullUrl = downloadPrefix ++ url
        filename = (resDir++) . takeWhile (/='?') $ takeFileName url
    putStrLn $ "Downloading: " ++ fullUrl
    -- req <- parseRequest fullUrl
    -- file <- httpLBS req
    -- LBS.writeFile filename $ getResponseBody file
    (("url(\""++filename)++) <$> fixCss rest
  | length css > 0 = (take 1 css ++) <$> fixCss (drop 1 css)
  | otherwise = return []

main' :: FilePath -> IO ()
main' fp = readFile fp >>= fixCss >>= writeFile ('_':fp)
